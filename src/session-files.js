import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { SESSION_DIRS } from "./constants.js";

async function listJsonlFiles(rootDir) {
  const entries = await fsp.readdir(rootDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonlFiles(fullPath)));
      continue;
    }
    if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }
  return files;
}

async function readFirstLineRecord(filePath) {
  const handle = await fsp.open(filePath, "r");
  try {
    let position = 0;
    let collected = Buffer.alloc(0);
    while (true) {
      const chunk = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) {
        break;
      }
      position += bytesRead;
      collected = Buffer.concat([collected, chunk.subarray(0, bytesRead)]);
      const newlineIndex = collected.indexOf(0x0a);
      if (newlineIndex !== -1) {
        const crlf = newlineIndex > 0 && collected[newlineIndex - 1] === 0x0d;
        const lineBuffer = crlf ? collected.subarray(0, newlineIndex - 1) : collected.subarray(0, newlineIndex);
        return {
          firstLine: lineBuffer.toString("utf8"),
          separator: crlf ? "\r\n" : "\n",
          offset: newlineIndex + 1
        };
      }
    }
    return {
      firstLine: collected.toString("utf8"),
      separator: "",
      offset: collected.length
    };
  } finally {
    await handle.close();
  }
}

function parseSessionMetaRecord(firstLine) {
  if (!firstLine) {
    return null;
  }
  try {
    const parsed = JSON.parse(firstLine);
    if (parsed?.type !== "session_meta" || typeof parsed?.payload !== "object" || parsed.payload === null) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function rewriteFirstLine(filePath, nextFirstLine, separator) {
  const current = await readFirstLineRecord(filePath);
  const tmpPath = `${filePath}.provider-sync.${process.pid}.${Date.now()}.tmp`;
  const writer = fs.createWriteStream(tmpPath, { encoding: "utf8" });

  await new Promise((resolve, reject) => {
    writer.on("error", reject);
    writer.write(nextFirstLine);
    if (separator) {
      writer.write(separator);
    }

    const headerOnly =
      current.separator === "" &&
      current.offset === Buffer.byteLength(current.firstLine, "utf8");

    if (headerOnly) {
      writer.end();
      writer.once("finish", resolve);
      return;
    }

    const reader = fs.createReadStream(filePath, { start: current.offset });
    reader.on("error", reject);
    reader.on("end", () => writer.end());
    writer.once("finish", resolve);
    reader.pipe(writer, { end: false });
  });

  await fsp.rename(tmpPath, filePath);
}

export async function collectSessionChanges(codexHome, targetProvider) {
  const summaries = [];
  const providerCounts = {
    sessions: new Map(),
    archived_sessions: new Map()
  };

  for (const dirName of SESSION_DIRS) {
    const rootDir = path.join(codexHome, dirName);
    try {
      await fsp.access(rootDir);
    } catch {
      continue;
    }
    const rolloutPaths = await listJsonlFiles(rootDir);
    for (const rolloutPath of rolloutPaths) {
      const record = await readFirstLineRecord(rolloutPath);
      const parsed = parseSessionMetaRecord(record.firstLine);
      if (!parsed) {
        continue;
      }
      const currentProvider = parsed.payload.model_provider ?? "(missing)";
      providerCounts[dirName].set(currentProvider, (providerCounts[dirName].get(currentProvider) ?? 0) + 1);

      if (targetProvider !== "__status_only__" && parsed.payload.model_provider !== targetProvider) {
        parsed.payload.model_provider = targetProvider;
        summaries.push({
          path: rolloutPath,
          directory: dirName,
          originalFirstLine: record.firstLine,
          originalSeparator: record.separator,
          updatedFirstLine: JSON.stringify(parsed)
        });
      }
    }
  }

  return { changes: summaries, providerCounts };
}

export async function applySessionChanges(changes) {
  for (const change of changes) {
    await rewriteFirstLine(change.path, change.updatedFirstLine, change.originalSeparator);
  }
}

export async function restoreSessionChanges(manifestEntries) {
  for (const entry of manifestEntries) {
    await rewriteFirstLine(entry.path, entry.originalFirstLine, entry.originalSeparator ?? "\n");
  }
}

export function summarizeProviderCounts(providerCounts) {
  const result = {};
  for (const [scope, counts] of Object.entries(providerCounts)) {
    result[scope] = Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
  }
  return result;
}
