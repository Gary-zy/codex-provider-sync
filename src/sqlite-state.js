import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DB_FILE_BASENAME } from "./constants.js";

export function stateDbPath(codexHome) {
  return path.join(codexHome, DB_FILE_BASENAME);
}

function openDatabase(dbPath) {
  return new DatabaseSync(dbPath);
}

export async function readSqliteProviderCounts(codexHome) {
  const dbPath = stateDbPath(codexHome);
  try {
    await fs.access(dbPath);
  } catch {
    return null;
  }

  const db = openDatabase(dbPath);
  try {
    const rows = db.prepare(`
      SELECT
        CASE
          WHEN model_provider IS NULL OR model_provider = '' THEN '(missing)'
          ELSE model_provider
        END AS model_provider,
        archived,
        COUNT(*) AS count
      FROM threads
      GROUP BY model_provider, archived
      ORDER BY archived, model_provider
    `).all();
    const result = {
      sessions: {},
      archived_sessions: {}
    };
    for (const row of rows) {
      const bucket = row.archived ? result.archived_sessions : result.sessions;
      bucket[row.model_provider] = row.count;
    }
    return result;
  } finally {
    db.close();
  }
}

export async function updateSqliteProvider(codexHome, targetProvider) {
  const dbPath = stateDbPath(codexHome);
  try {
    await fs.access(dbPath);
  } catch {
    return { updatedRows: 0, databasePresent: false };
  }

  const db = openDatabase(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    const stmt = db.prepare(`
      UPDATE threads
      SET model_provider = ?
      WHERE COALESCE(model_provider, '') <> ?
    `);
    const result = stmt.run(targetProvider, targetProvider);
    db.exec("COMMIT");
    return { updatedRows: result.changes ?? 0, databasePresent: true };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback failures and surface the original error.
    }
    throw error;
  } finally {
    db.close();
  }
}
