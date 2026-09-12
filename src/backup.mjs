import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { backup as backupDatabase } from 'node:sqlite';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { loadConfig } from './config.mjs';
import { openDatabase } from './db.mjs';

function backupError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function filesBelow(root, prefix = '') {
  const directory = join(root, prefix);
  const entries = await readdir(directory, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relativePath = join(prefix, entry.name);
    if (entry.isSymbolicLink()) {
      throw backupError('backup_integrity_failed', 'Backup objects cannot contain symbolic links');
    }
    if (entry.isDirectory()) files.push(...await filesBelow(root, relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files;
}

function requireAbsolute(path, field) {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw backupError('invalid_path', `${field} must be an absolute path`);
  }
  return resolve(path);
}

function isInside(parent, child) {
  const path = relative(parent, child);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function safeManifestPath(value) {
  if (typeof value !== 'string' || value.length === 0 || isAbsolute(value)) return false;
  const normalized = value.replaceAll('\\', '/');
  return normalized === 'social-memory.sqlite' ||
    (normalized.startsWith('objects/') && !normalized.split('/').includes('..'));
}

async function copyObjects(config, destination) {
  const objectFiles = await filesBelow(config.objectsDir);
  for (const relativePath of objectFiles) {
    const target = join(destination, 'objects', relativePath);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(join(config.objectsDir, relativePath), target);
    await chmod(target, 0o600);
  }
  return objectFiles.map((path) => join('objects', path));
}

export async function createBackup({ db, config, outputDir, clock = () => new Date() }) {
  const destination = requireAbsolute(outputDir, 'Backup destination');
  if (isInside(config.dataDir, destination)) {
    throw backupError('invalid_path', 'Backup destination must be outside the live library');
  }
  if (await exists(destination)) {
    throw backupError('backup_destination_exists', 'Backup destination already exists');
  }
  const temporary = `${destination}.partial-${process.pid}`;
  if (await exists(temporary)) {
    throw backupError('backup_destination_exists', 'Temporary backup destination already exists');
  }

  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await mkdir(temporary, { mode: 0o700 });
  try {
    const databasePath = join(temporary, 'social-memory.sqlite');
    await backupDatabase(db, databasePath);
    await chmod(databasePath, 0o600);
    const objectPaths = await copyObjects(config, temporary);
    const paths = ['social-memory.sqlite', ...objectPaths].sort();
    const files = [];
    for (const path of paths) {
      const absolutePath = join(temporary, path);
      const details = await lstat(absolutePath);
      files.push({ path: path.split(sep).join('/'), bytes: details.size, sha256: await sha256(absolutePath) });
    }
    const schemaVersion = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version;
    const manifest = {
      format: 'social-memory-backup',
      version: 1,
      createdAt: clock().toISOString(),
      schemaVersion,
      files,
    };
    await writeFile(join(temporary, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, destination);
    return { status: 'created', backupDir: destination, schemaVersion, fileCount: files.length };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function validatedManifest(backupDir) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(backupDir, 'manifest.json'), 'utf8'));
  } catch {
    throw backupError('backup_integrity_failed', 'Backup manifest is missing or invalid');
  }
  if (
    manifest?.format !== 'social-memory-backup' ||
    manifest.version !== 1 ||
    !Array.isArray(manifest.files) ||
    !manifest.files.some(({ path }) => path === 'social-memory.sqlite')
  ) {
    throw backupError('backup_integrity_failed', 'Backup manifest contract is invalid');
  }
  for (const entry of manifest.files) {
    if (!safeManifestPath(entry.path) || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw backupError('backup_integrity_failed', 'Backup manifest contains an unsafe file entry');
    }
    const path = join(backupDir, entry.path);
    const details = await lstat(path).catch(() => null);
    if (!details?.isFile() || details.isSymbolicLink() || details.size !== entry.bytes) {
      throw backupError('backup_integrity_failed', 'Backup file metadata does not match the manifest');
    }
    if (await sha256(path) !== entry.sha256) {
      throw backupError('backup_integrity_failed', 'Backup file hash does not match the manifest');
    }
  }
  return manifest;
}

export async function restoreBackup({ backupDir, dataDir }) {
  const source = requireAbsolute(backupDir, 'Backup source');
  const destination = requireAbsolute(dataDir, 'Restore destination');
  if (source === destination || isInside(source, destination) || isInside(destination, source)) {
    throw backupError('invalid_path', 'Backup source and restore destination cannot overlap');
  }
  const manifest = await validatedManifest(source);
  if (await exists(destination)) {
    throw backupError('restore_destination_exists', 'Restore destination already exists');
  }
  const temporary = `${destination}.partial-${process.pid}`;
  if (await exists(temporary)) {
    throw backupError('restore_destination_exists', 'Temporary restore destination already exists');
  }

  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await mkdir(temporary, { mode: 0o700 });
  try {
    for (const entry of manifest.files) {
      const target = join(temporary, entry.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(join(source, entry.path), target);
      await chmod(target, 0o600);
    }
    const temporaryConfig = loadConfig({ SOCIAL_MEMORY_DATA_DIR: temporary });
    for (const directory of [
      temporaryConfig.objectsDir,
      temporaryConfig.stagingDir,
      temporaryConfig.exportsDir,
      temporaryConfig.logsDir,
    ]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }
    await writeFile(
      temporaryConfig.configPath,
      `${JSON.stringify({ version: 1, dataDir: destination }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const restoredDb = openDatabase(temporaryConfig.dbPath);
    try {
      const integrity = restoredDb.prepare('PRAGMA integrity_check').get().integrity_check;
      if (integrity !== 'ok') throw backupError('backup_integrity_failed', 'Restored database failed integrity check');
    } finally {
      restoredDb.close();
    }
    await rename(temporary, destination);
    return {
      status: 'restored',
      dataDir: destination,
      sourceSchemaVersion: manifest.schemaVersion,
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
