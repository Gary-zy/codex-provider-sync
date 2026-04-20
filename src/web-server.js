import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";

import {
  getStatus,
  runSync,
  runSwitch,
  runRestore,
  runPruneBackups
} from "./service.js";
import { defaultBackupRoot, defaultCodexHome } from "./constants.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function json(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(data));
}

async function listBackupDirs(codexHome) {
  const backupRoot = defaultBackupRoot(codexHome);
  let entries;
  try {
    entries = await fs.readdir(backupRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const metaPath = path.join(backupRoot, e.name, "metadata.json");
    try {
      const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
      if (meta?.namespace === "provider-sync") {
        dirs.push({
          name: e.name,
          fullPath: path.join(backupRoot, e.name),
          targetProvider: meta.targetProvider,
          createdAt: meta.createdAt,
          changedFiles: meta.changedSessionFiles ?? 0
        });
      }
    } catch { /* skip */ }
  }
  return dirs.sort((a, b) => b.name.localeCompare(a.name));
}

import { DatabaseSync } from "node:sqlite";
import { DB_FILE_BASENAME, SESSION_DIRS } from "./constants.js";

function listSessionsFromDb(codexHome) {
  const dbPath = path.join(codexHome, DB_FILE_BASENAME);
  try { fs.access(dbPath); } catch { return { sessions: [], edges: [] }; }
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare(`
      SELECT id, title, model_provider, cwd, rollout_path,
             created_at, updated_at, archived, source,
             model, first_user_message
      FROM threads ORDER BY updated_at DESC
    `).all();
    const sessions = rows.map(r => ({
      ...r,
      created_at_iso: new Date(r.created_at * 1000).toISOString(),
      updated_at_iso: new Date(r.updated_at * 1000).toISOString(),
    }));
    // 读取父子关系边
    let edges = [];
    try {
      edges = db.prepare(
        "SELECT parent_thread_id, child_thread_id, status FROM thread_spawn_edges"
      ).all();
    } catch { /* 表可能不存在 */ }
    // 标记每个会话的 parentId
    const childToParent = new Map();
    for (const e of edges) childToParent.set(e.child_thread_id, e.parent_thread_id);
    for (const s of sessions) {
      s.parentId = childToParent.get(s.id) || null;
    }
    return { sessions, edges };
  } finally { db.close(); }
}

function quoteSqliteIdentifier(value) {
  return `"${String(value).replaceAll("\"", "\"\"")}"`;
}

function listThreadReferenceCleanupPlans(db) {
  const tables = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).all();

  const plans = [];
  for (const table of tables) {
    if (table.name === "threads") continue;
    const columnRows = db.prepare(`PRAGMA table_info(${quoteSqliteIdentifier(table.name)})`).all();
    const columns = new Set(columnRows.map((row) => row.name));
    const clauses = [];
    if (columns.has("thread_id")) clauses.push("thread_id = ?");
    if (columns.has("parent_thread_id")) clauses.push("parent_thread_id = ?");
    if (columns.has("child_thread_id")) clauses.push("child_thread_id = ?");
    if (!clauses.length) continue;
    plans.push({
      tableName: table.name,
      whereClause: clauses.join(" OR "),
      parameterCount: clauses.length
    });
  }
  return plans;
}

function deleteThreadReferences(db, sessionId) {
  for (const plan of listThreadReferenceCleanupPlans(db)) {
    db.prepare(
      `DELETE FROM ${quoteSqliteIdentifier(plan.tableName)} WHERE ${plan.whereClause}`
    ).run(...Array(plan.parameterCount).fill(sessionId));
  }
}

async function deleteSessionById(codexHome, sessionId) {
  const dbPath = path.join(codexHome, DB_FILE_BASENAME);
  let rolloutPath = null;
  const db = new DatabaseSync(dbPath);
  let transactionOpen = false;
  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;
    const row = db.prepare("SELECT rollout_path FROM threads WHERE id = ?").get(sessionId);
    if (!row) throw new Error(`会话 ${sessionId} 不存在`);
    rolloutPath = row.rollout_path;
    deleteThreadReferences(db, sessionId);
    db.prepare("DELETE FROM threads WHERE id = ?").run(sessionId);
    db.exec("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failures and surface the original error.
      }
    }
    throw error;
  } finally { db.close(); }

  if (rolloutPath) {
    const fullPath = path.resolve(codexHome, rolloutPath);
    const dirPath = path.dirname(fullPath);
    await fs.rm(fullPath, { force: true });
    // 如果会话目录为空也删掉
    try {
      const remaining = await fs.readdir(dirPath);
      if (remaining.length === 0) await fs.rmdir(dirPath);
    } catch { /* 忽略 */ }
  }
  return { deletedId: sessionId, rolloutPath };
}

async function handleApi(req, res, codexHome) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    return res.end();
  }

  if (url.pathname === "/api/status" && req.method === "GET") {
    const status = await getStatus({ codexHome });
    const backups = await listBackupDirs(codexHome);
    return json(res, { ...status, backups });
  }
  if (url.pathname === "/api/sessions" && req.method === "GET") {
    const result = listSessionsFromDb(codexHome);
    return json(res, result);
  }
  if (url.pathname === "/api/sessions/delete" && req.method === "POST") {
    const body = await readBody(req);
    const ids = body.ids || [];
    if (!ids.length) throw new Error("未提供要删除的会话 ID");
    const results = [];
    for (const id of ids) {
      results.push(await deleteSessionById(codexHome, id));
    }
    return json(res, { deleted: results.length, results });
  }
  if (url.pathname === "/api/sync" && req.method === "POST") {
    const body = await readBody(req);
    const result = await runSync({
      codexHome,
      provider: body.provider || undefined,
      keepCount: body.keepCount || 5
    });
    return json(res, result);
  }
  if (url.pathname === "/api/switch" && req.method === "POST") {
    const body = await readBody(req);
    const result = await runSwitch({
      codexHome,
      provider: body.provider,
      keepCount: body.keepCount || 5
    });
    return json(res, result);
  }
  if (url.pathname === "/api/restore" && req.method === "POST") {
    const body = await readBody(req);
    const result = await runRestore({
      codexHome, backupDir: body.backupDir
    });
    return json(res, result);
  }
  if (url.pathname === "/api/prune" && req.method === "POST") {
    const body = await readBody(req);
    const result = await runPruneBackups({
      codexHome, keepCount: body.keepCount ?? 5
    });
    return json(res, result);
  }
  res.writeHead(404);
  res.end("Not found");
}

export async function startWebServer({ codexHome: explicitCodexHome, port = 3456 } = {}) {
  const codexHome = path.resolve(explicitCodexHome ?? process.env.CODEX_HOME ?? defaultCodexHome());
  const htmlPath = path.join(__dirname, "web-ui.html");
  let html = await fs.readFile(htmlPath, "utf8");

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(html);
      }
      if (url.pathname.startsWith("/api/")) {
        return await handleApi(req, res, codexHome);
      }
      res.writeHead(404);
      res.end("Not found");
    } catch (err) {
      json(res, { error: err.message }, 500);
    }
  });

  return new Promise((resolve, reject) => {
    server.on("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.log(`端口 ${port} 已被占用，尝试随机端口...`);
        server.listen(0, "127.0.0.1");
      } else {
        reject(err);
      }
    });
    server.on("listening", () => {
      const addr = server.address();
      const url = `http://127.0.0.1:${addr.port}`;
      console.log(`\n  Codex Provider Sync GUI`);
      console.log(`  ${url}\n`);
      console.log(`  按 Ctrl+C 退出\n`);
      const cmd = process.platform === "darwin"
        ? "open" : process.platform === "win32"
        ? "start" : "xdg-open";
      exec(`${cmd} ${url}`);
      resolve({ server, url, port: addr.port });
    });
    server.listen(port, "127.0.0.1");
  });
}
