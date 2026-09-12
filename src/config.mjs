import { chmod, lstat, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

export function loadConfig(env = process.env) {
  const requestedDataDir = env.SOCIAL_MEMORY_DATA_DIR;
  if (!requestedDataDir || !isAbsolute(requestedDataDir)) {
    throw new Error('SOCIAL_MEMORY_DATA_DIR must be an absolute path');
  }

  const dataDir = resolve(requestedDataDir);
  return Object.freeze({
    dataDir,
    dbPath: join(dataDir, 'social-memory.sqlite'),
    objectsDir: join(dataDir, 'objects'),
    stagingDir: join(dataDir, 'staging'),
    exportsDir: join(dataDir, 'exports'),
    logsDir: join(dataDir, 'logs'),
    configPath: join(dataDir, 'config.json'),
  });
}

async function rejectUnsafeExistingFile(path, label) {
  const details = await lstat(path).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (details?.isSymbolicLink()) throw new Error(`${label} cannot be a symbolic link`);
  if (details && !details.isFile()) throw new Error(`${label} must be a regular file`);
}

export async function initializeLibrary(config) {
  const directories = [
    config.dataDir,
    config.objectsDir,
    config.stagingDir,
    config.exportsDir,
    config.logsDir,
  ];

  for (const directory of directories) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }

  await rejectUnsafeExistingFile(config.configPath, 'Library config');
  await rejectUnsafeExistingFile(config.dbPath, 'Library database');
  for (const suffix of ['-wal', '-shm', '-journal']) {
    await rejectUnsafeExistingFile(`${config.dbPath}${suffix}`, `Library database${suffix}`);
  }

  const configDocument = `${JSON.stringify({ version: 1, dataDir: config.dataDir }, null, 2)}\n`;
  try {
    await writeFile(config.configPath, configDocument, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  await chmod(config.configPath, 0o600);

  const { openDatabase } = await import('./db.mjs');
  const db = openDatabase(config.dbPath);
  db.close();
  await chmod(config.dbPath, 0o600);
}
