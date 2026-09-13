import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { configureAccount } from '../src/accounts.mjs';
import { initializeLibrary, loadConfig } from '../src/config.mjs';
import { createConnectorRegistry } from '../src/connectors/registry.mjs';
import {
  createAsideThreadsBridge,
  createThreadsConnector,
  parseAsideBridgeOutput,
} from '../src/connectors/threads.mjs';
import { openDatabase } from '../src/db.mjs';
import { runSync } from '../src/sync.mjs';

async function createContext(t, connector) {
  const dataDir = await mkdtemp(join(tmpdir(), 'social-memory-threads-'));
  const config = loadConfig({ SOCIAL_MEMORY_DATA_DIR: dataDir });
  await initializeLibrary(config);
  const db = openDatabase(config.dbPath);
  t.after(() => db.close());
  return { config, db, registry: createConnectorRegistry([connector]) };
}

function item(postId = 'shared-post') {
  return {
    postId,
    sourceUrl: `https://www.threads.com/@writer/post/${postId}`,
    authorHandle: 'writer',
    authorName: 'Writer',
    text: 'A reusable product idea',
    postedAt: '2026-09-01T02:03:04.000Z',
    assets: [{ kind: 'image', sourceUrl: `https://cdn.example.test/${postId}.jpg`, altText: 'diagram' }],
  };
}

function bridge({ handle = 'reader_one', surfaceResult } = {}) {
  const calls = [];
  return {
    calls,
    async inspectIdentity(input) {
      calls.push({ operation: 'verify', ...input });
      return { handle, profileUrl: `https://www.threads.com/@${handle}` };
    },
    async readSurface(input) {
      calls.push({ operation: 'collect', ...input });
      return surfaceResult?.(input) ?? {
        items: [item()],
        cursor: `${input.surface}-next`,
        landmarks: [
          { likes: 'like_state', saved: 'saved_surface', reposts: 'reposts_tab' }[input.surface],
          'post_permalink',
        ],
      };
    },
  };
}

test('Threads sync verifies the dedicated profile and reads only selected capture kinds', async (t) => {
  const browserBridge = bridge();
  const connector = createThreadsConnector({ browserBridge });
  const { config, db, registry } = await createContext(t, connector);
  configureAccount(db, registry, {
    connectorId: 'threads',
    identity: '@reader_one',
    profileRef: 'threads-reader-one',
    selectedCaptureKinds: ['save'],
  });

  const summary = await runSync({ db, config, registry, limit: 12 });

  assert.equal(summary.status, 'success');
  assert.deepEqual(browserBridge.calls, [
    { operation: 'verify', profileRef: 'threads-reader-one' },
    {
      operation: 'collect',
      profileRef: 'threads-reader-one',
      surface: 'saved',
      cursor: null,
      limit: 12,
    },
  ]);
  assert.deepEqual(
    db.prepare('SELECT kind, native_kind FROM captures').all().map((row) => ({ ...row })),
    [{ kind: 'save', native_kind: 'saved' }],
  );
});

test('Threads browser connector can be registered under the Chrome connector id', () => {
  const connector = createThreadsConnector({ id: 'threads-chrome', browserBridge: bridge() });

  assert.equal(connector.id, 'threads-chrome');
  assert.deepEqual(connector.capabilities, ['like', 'save', 'repost']);
});

test('Threads keeps like and save as distinct captures of one source', async (t) => {
  const connector = createThreadsConnector({ browserBridge: bridge() });
  const { config, db, registry } = await createContext(t, connector);
  configureAccount(db, registry, {
    connectorId: 'threads',
    identity: 'reader_one',
    profileRef: 'threads-reader-one',
    selectedCaptureKinds: ['like', 'save'],
  });

  await runSync({ db, config, registry });

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sources').get().count, 1);
  assert.deepEqual(
    db.prepare('SELECT kind, native_kind FROM captures ORDER BY kind').all().map((row) => ({ ...row })),
    [
      { kind: 'like', native_kind: 'like' },
      { kind: 'save', native_kind: 'saved' },
    ],
  );
});

test('Threads account mismatch blocks all surface reads', async (t) => {
  const browserBridge = bridge({ handle: 'different_reader' });
  const connector = createThreadsConnector({ browserBridge });
  const { config, db, registry } = await createContext(t, connector);
  configureAccount(db, registry, {
    connectorId: 'threads',
    identity: 'reader_one',
    profileRef: 'threads-reader-one',
    selectedCaptureKinds: ['like', 'save'],
  });

  const summary = await runSync({ db, config, registry });

  assert.equal(summary.status, 'failed');
  assert.equal(browserBridge.calls.filter(({ operation }) => operation === 'collect').length, 0);
  assert.ok(summary.streams.every(({ errorCode }) => errorCode === 'account_mismatch'));
});

test('Threads UI drift fails closed and cannot advance the stream cursor', async (t) => {
  const connector = createThreadsConnector({
    browserBridge: bridge({
      surfaceResult: () => ({ items: [], cursor: 'must-not-commit', landmarks: [] }),
    }),
  });
  const { config, db, registry } = await createContext(t, connector);
  configureAccount(db, registry, {
    connectorId: 'threads',
    identity: 'reader_one',
    profileRef: 'threads-reader-one',
    selectedCaptureKinds: ['save'],
  });

  const summary = await runSync({ db, config, registry });

  assert.equal(summary.streams[0].errorCode, 'connector_drift');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sync_cursors').get().count, 0);
});

test('Threads configuration requires a safe dedicated profile reference', async (t) => {
  const connector = createThreadsConnector({ browserBridge: bridge() });
  const { db, registry } = await createContext(t, connector);
  const base = {
    connectorId: 'threads',
    identity: 'reader_one',
    selectedCaptureKinds: ['save'],
  };

  assert.throws(
    () => configureAccount(db, registry, { ...base, profileRef: 'bad profile; echo injected' }),
    /profile reference/i,
  );
  assert.throws(
    () => configureAccount(db, registry, {
      ...base,
      profileRef: 'threads-reader-one',
      connectorConfig: { command: 'anything' },
    }),
    /unknown Threads connector config/i,
  );
});

test('Threads reconfiguration can retain an already verified profile reference', async (t) => {
  const connector = createThreadsConnector({ browserBridge: bridge() });
  const { db, registry } = await createContext(t, connector);
  const base = {
    connectorId: 'threads',
    identity: 'reader_one',
    selectedCaptureKinds: ['save'],
  };
  configureAccount(db, registry, { ...base, profileRef: 'threads-reader-one' });

  const updated = configureAccount(db, registry, {
    ...base,
    selectedCaptureKinds: ['like', 'save'],
  });

  assert.equal(updated.profileRef, 'threads-reader-one');
});

test('Aside bridge output accepts ANSI but requires exactly one JSON marker', () => {
  assert.deepEqual(
    parseAsideBridgeOutput('\u001b[2mworking\u001b[0m\nSOCIAL_MEMORY_JSON:{"handle":"safe"}\u001b[0m\n'),
    { handle: 'safe' },
  );
  assert.throws(() => parseAsideBridgeOutput('ordinary prose'), /exactly one JSON marker/i);
  assert.throws(
    () => parseAsideBridgeOutput('SOCIAL_MEMORY_JSON:{}\nSOCIAL_MEMORY_JSON:{}'),
    /exactly one JSON marker/i,
  );
});

test('Aside bridge pins subprocess work to the configured account profile', async () => {
  const invocations = [];
  const asideBridge = createAsideThreadsBridge({
    execFileImpl: async (command, args, options) => {
      invocations.push({ command, args, options });
      return { stdout: 'SOCIAL_MEMORY_JSON:{"handle":"reader_one"}\n', stderr: '' };
    },
  });

  assert.equal((await asideBridge.inspectIdentity({ profileRef: 'profile-one' })).handle, 'reader_one');

  assert.equal(invocations[0].command, 'aside');
  assert.deepEqual(invocations[0].args.slice(0, 3), ['repl', '--account', 'profile-one']);
  assert.match(invocations[0].args[3], /SOCIAL_MEMORY_JSON/);
  assert.equal(invocations[0].options.shell, false);
});
