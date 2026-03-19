import fs from "node:fs/promises";
import path from "node:path";

import { BACKUP_NAMESPACE, DB_FILE_BASENAME, defaultBackupRoot } from "./constants.js";
import { restoreSessionChanges } from "./session-files.js";

function timestampSlug(date = new Date()) {
  return date.toISOString().replaceAll(":", "").replaceAll("-", "").replace(".", "");
}

async function copyIfPresent(sourcePath, destinationPath) {
  try {
    await fs.access(sourcePath);
  } catch {
    return false;
  }
  await fs.copyFile(sourcePath, destinationPath);
  return true;
}

async function removeIfPresent(targetPath) {
  await fs.rm(targetPath, { force: true });
}

export async function createBackup({
  codexHome,
  targetProvider,
  sessionChanges,
  configPath,
  configBackupText
}) {
  const backupRoot = defaultBackupRoot(codexHome);
  const backupDir = path.join(backupRoot, timestampSlug());
  const dbDir = path.join(backupDir, "db");
  await fs.mkdir(dbDir, { recursive: true });

  const copiedDbFiles = [];
  for (const suffix of ["", "-shm", "-wal"]) {
    const fileName = `${DB_FILE_BASENAME}${suffix}`;
    const copied = await copyIfPresent(path.join(codexHome, fileName), path.join(dbDir, fileName));
    if (copied) {
      copiedDbFiles.push(fileName);
    }
  }

  if (configBackupText !== undefined) {
    await fs.writeFile(path.join(backupDir, "config.toml"), configBackupText, "utf8");
  } else {
    await copyIfPresent(configPath, path.join(backupDir, "config.toml"));
  }

  const sessionManifest = {
    version: 1,
    namespace: BACKUP_NAMESPACE,
    codexHome,
    targetProvider,
    createdAt: new Date().toISOString(),
    files: sessionChanges.map((change) => ({
      path: change.path,
      originalFirstLine: change.originalFirstLine,
      originalSeparator: change.originalSeparator
    }))
  };
  await fs.writeFile(
    path.join(backupDir, "session-meta-backup.json"),
    JSON.stringify(sessionManifest, null, 2),
    "utf8"
  );

  await fs.writeFile(
    path.join(backupDir, "metadata.json"),
    JSON.stringify(
      {
        version: 1,
        namespace: BACKUP_NAMESPACE,
        codexHome,
        targetProvider,
        createdAt: sessionManifest.createdAt,
        dbFiles: copiedDbFiles,
        changedSessionFiles: sessionChanges.length
      },
      null,
      2
    ),
    "utf8"
  );

  return backupDir;
}

export async function restoreBackup(backupDir, codexHome) {
  const metadataPath = path.join(backupDir, "metadata.json");
  const metadata = JSON.parse(await fs.readFile(metadataPath, "utf8"));
  if (metadata.codexHome !== codexHome) {
    throw new Error(`Backup was created for ${metadata.codexHome}, not ${codexHome}.`);
  }

  const configBackupPath = path.join(backupDir, "config.toml");
  await copyIfPresent(configBackupPath, path.join(codexHome, "config.toml"));

  const dbDir = path.join(backupDir, "db");
  const backedUpFiles = new Set(metadata.dbFiles ?? []);
  for (const suffix of ["", "-shm", "-wal"]) {
    const fileName = `${DB_FILE_BASENAME}${suffix}`;
    if (!backedUpFiles.has(fileName)) {
      await removeIfPresent(path.join(codexHome, fileName));
    }
  }
  for (const fileName of metadata.dbFiles ?? []) {
    await copyIfPresent(path.join(dbDir, fileName), path.join(codexHome, fileName));
  }

  const sessionManifestPath = path.join(backupDir, "session-meta-backup.json");
  const sessionManifest = JSON.parse(await fs.readFile(sessionManifestPath, "utf8"));
  await restoreSessionChanges(sessionManifest.files ?? []);

  return metadata;
}
