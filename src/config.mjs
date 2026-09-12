import { chmod, mkdir, writeFile } from 'node:fs/promises';
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
