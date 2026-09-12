import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { configureAccount } from '../src/accounts.mjs';
import { initializeLibrary, loadConfig } from '../src/config.mjs';
import { createConnectorRegistry } from '../src/connectors/registry.mjs';
import { openDatabase } from '../src/db.mjs';
import { createLaunchAgentManager } from '../src/scheduler.mjs';
import { runSync } from '../src/sync.mjs';

function connector() {
  return {
    id: 'fixture',
    capabilities: ['like', 'save'],
    async verify({ account }) {
      return {
        status: 'ready',
        configuredIdentity: account.configuredIdentity,
        authenticatedIdentity: account.configuredIdentity,
      };
    },
    async collect({ kind }) {
      return { events: [], nextCursor: `${kind}-done` };
    },
  };
}

async function context(t) {
  const root = await mkdtemp(join(tmpdir(), 'social-memory-scheduler-'));
  const dataDir = join(root, 'library');
  const homeDir = join(root, 'home');
  const config = loadConfig({ SOCIAL_MEMORY_DATA_DIR: dataDir });
  await initializeLibrary(config);
  const db = openDatabase(config.dbPath);
  t.after(() => db.close());
  const registry = createConnectorRegistry([connector()]);
  return { config, db, homeDir, registry };
}

test('scheduler install is blocked until every selected stream has a manual success receipt', async (t) => {
  const { config, db, homeDir, registry } = await context(t);
  const account = configureAccount(db, registry, {
    connectorId: 'fixture',
    identity: 'reader_one',
    selectedCaptureKinds: ['like', 'save'],
  });
  const manager = createLaunchAgentManager({ homeDir, execFileImpl: async () => ({}) });

  await assert.rejects(() => manager.install({ db, config, intervalMinutes: 60 }), /manual sync/i);
  await runSync({ db, config, registry, filters: { accountId: account.id, kind: 'like' } });
  await assert.rejects(() => manager.install({ db, config, intervalMinutes: 60 }), /manual sync/i);
});

test('scheduler installs only after receipts cover the exact selected streams', async (t) => {
  const { config, db, homeDir, registry } = await context(t);
  configureAccount(db, registry, {
    connectorId: 'fixture',
    identity: 'reader_one',
    selectedCaptureKinds: ['like', 'save'],
  });
  await runSync({ db, config, registry });
  const calls = [];
  const manager = createLaunchAgentManager({
    homeDir,
    uid: 501,
    nodePath: '/opt/node/bin/node',
    cliPath: '/opt/social memory/src/cli.mjs',
    pathValue: '/Users/example/.local/bin:/usr/bin:/bin',
    execFileImpl: async (command, args) => {
      calls.push({ command, args });
      return { stdout: '', stderr: '' };
    },
  });

  const installed = await manager.install({ db, config, intervalMinutes: 60 });
  const plist = await readFile(installed.plistPath, 'utf8');

  assert.match(plist, /<integer>3600<\/integer>/);
  assert.match(plist, /\/opt\/social memory\/src\/cli\.mjs/);
  assert.match(plist, /<string>--scheduled<\/string>/);
  assert.match(plist, /\/Users\/example\/\.local\/bin:\/usr\/bin:\/bin/);
  assert.match(plist, new RegExp(config.dataDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(calls.at(-1), {
    command: 'launchctl',
    args: ['bootstrap', 'gui/501', installed.plistPath],
  });
});

test('scheduled sync cannot mint a manual success receipt', async (t) => {
  const { config, db, registry } = await context(t);
  configureAccount(db, registry, {
    connectorId: 'fixture',
    identity: 'reader_one',
    selectedCaptureKinds: ['save'],
  });

  await runSync({ db, config, registry, trigger: 'scheduled' });

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM manual_sync_receipts').get().count, 0);
});

test('scheduler uninstall keeps the plist when a loaded agent cannot be stopped', async (t) => {
  const { config, homeDir } = await context(t);
  const calls = [];
  const manager = createLaunchAgentManager({
    homeDir,
    uid: 501,
    execFileImpl: async (command, args) => {
      calls.push({ command, args });
      if (args[0] === 'bootout') throw new Error('permission denied');
      if (args[0] === 'print') return { stdout: 'loaded' };
      return { stdout: '' };
    },
  });
  const descriptor = await manager.status({ config });
  await mkdir(join(homeDir, 'Library', 'LaunchAgents'), { recursive: true });
  await writeFile(descriptor.plistPath, 'placeholder');

  await assert.rejects(
    () => manager.uninstall({ config }),
    (error) => error.code === 'schedule_unload_failed',
  );
  assert.equal(await readFile(descriptor.plistPath, 'utf8'), 'placeholder');
  assert.deepEqual(calls.map(({ args }) => args[0]), ['bootout', 'print']);
});
