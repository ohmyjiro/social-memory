import { lstatSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

function rejectUnsafeDatabasePath(path) {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    let details;
    try {
      details = lstatSync(candidate);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (details.isSymbolicLink()) throw new Error(`Database path cannot use a symbolic link: ${candidate}`);
    if (candidate === path && !details.isFile()) {
      throw new Error(`Database path must be a regular file: ${candidate}`);
    }
  }
}

export function openDatabase(dbPath) {
  rejectUnsafeDatabasePath(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sources'").get() &&
      !db.prepare('PRAGMA table_info(sources)').all().some((column) => column.name === 'platform')) {
      throw new Error('Legacy library is unsupported; use a new data directory. Existing data was not converted.');
    }
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec(schema);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
