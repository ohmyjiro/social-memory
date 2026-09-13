import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { configureAccount } from '../src/accounts.mjs';
import { initializeLibrary, loadConfig } from '../src/config.mjs';
import { createConnectorRegistry } from '../src/connectors/registry.mjs';
import {
  createAsideXBridge,
  createXAsideConnector,
  parseAsideXOutput,
} from '../src/connectors/x-aside.mjs';
import { openDatabase } from '../src/db.mjs';
import { runSync } from '../src/sync.mjs';

async function context(t, connector) {
  const dataDir = await mkdtemp(join(tmpdir(), 'social-memory-x-aside-'));
  const config = loadConfig({ SOCIAL_MEMORY_DATA_DIR: dataDir });
  await initializeLibrary(config);
  const db = openDatabase(config.dbPath);
  t.after(() => db.close());
  return { config, db, registry: createConnectorRegistry([connector]) };
}

function fakeBridge({ handle = 'reader_one' } = {}) {
  const calls = [];
  return {
    calls,
    async inspectIdentity(input) {
      calls.push({ operation: 'verify', ...input });
      return { handle };
    },
    async readSurface(input) {
      calls.push({ operation: 'collect', ...input });
      const native = { likes: 'like', bookmarks: 'bookmark', reposts: 'repost' }[input.surface];
      return {
        items: [{
          postId: 'shared-post',
          sourceUrl: 'https://x.com/writer/status/shared-post',
          authorHandle: 'writer',
          authorName: 'Writer',
          text: 'Shared product idea',
          postedAt: '2026-09-01T00:00:00.000Z',
          assets: [],
        }],
        cursor: `${input.surface}-next`,
        landmarks: [
          input.surface === 'bookmarks' ? 'bookmarks_api' : `${input.surface}_state`,
          input.surface === 'bookmarks' ? 'post_identity' : 'post_permalink',
        ],
        native,
      };
    },
  };
}

test('X Aside verifies one profile and reads only the selected native surface', async (t) => {
  const browserBridge = fakeBridge();
  const connector = createXAsideConnector({ browserBridge });
  const { config, db, registry } = await context(t, connector);
  configureAccount(db, registry, {
    connectorId: 'x-aside',
    identity: '@reader_one',
    profileRef: 'x-reader-one',
    selectedCaptureKinds: ['save'],
  });

  const summary = await runSync({ db, config, registry, limit: 7 });

  assert.equal(summary.status, 'success');
  assert.deepEqual(browserBridge.calls, [
    { operation: 'verify', profileRef: 'x-reader-one' },
    {
      operation: 'collect',
      profileRef: 'x-reader-one',
      surface: 'bookmarks',
      handle: 'reader_one',
      cursor: null,
      limit: 7,
    },
  ]);
  assert.deepEqual(
    db.prepare('SELECT kind, native_kind FROM captures').all().map((row) => ({ ...row })),
    [{ kind: 'save', native_kind: 'bookmark' }],
  );
});

test('X browser connector accepts Chrome bookmark landmarks under its own connector id', async (t) => {
  const browserBridge = fakeBridge();
  browserBridge.readSurface = async (input) => ({
    items: [{
      postId: 'chrome-bookmark',
      sourceUrl: 'https://x.com/writer/status/chrome-bookmark',
      authorHandle: 'writer',
      authorName: null,
      text: 'Chrome bookmark',
      postedAt: '2026-09-01T00:00:00.000Z',
      assets: [],
    }],
    cursor: null,
    landmarks: ['bookmarks_state', 'post_permalink'],
  });
  const connector = createXAsideConnector({
    id: 'x-chrome',
    browserBridge,
    bookmarkLandmark: 'bookmarks_state',
    bookmarkItemLandmark: 'post_permalink',
  });
  const { config, db, registry } = await context(t, connector);
  configureAccount(db, registry, {
    connectorId: 'x-chrome',
    identity: 'reader_one',
    profileRef: 'reader-one',
    selectedCaptureKinds: ['save'],
  });

  const result = await runSync({ db, config, registry });

  assert.equal(connector.id, 'x-chrome');
  assert.equal(result.status, 'success');
  assert.equal(db.prepare('SELECT native_kind FROM captures').get().native_kind, 'bookmark');
});

test('X Aside preserves like and save as distinct captures for a shared source', async (t) => {
  const connector = createXAsideConnector({ browserBridge: fakeBridge() });
  const { config, db, registry } = await context(t, connector);
  configureAccount(db, registry, {
    connectorId: 'x-aside',
    identity: 'reader_one',
    profileRef: 'x-reader-one',
    selectedCaptureKinds: ['like', 'save'],
  });

  await runSync({ db, config, registry });

  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sources').get().count, 1);
  assert.deepEqual(
    db.prepare('SELECT kind, native_kind FROM captures ORDER BY kind').all().map((row) => ({ ...row })),
    [
      { kind: 'like', native_kind: 'like' },
      { kind: 'save', native_kind: 'bookmark' },
    ],
  );
});

test('X Aside mismatch and UI drift fail before cursor advancement', async (t) => {
  const mismatchBridge = fakeBridge({ handle: 'other_reader' });
  const mismatchConnector = createXAsideConnector({ browserBridge: mismatchBridge });
  const first = await context(t, mismatchConnector);
  configureAccount(first.db, first.registry, {
    connectorId: 'x-aside', identity: 'reader_one', profileRef: 'x-reader-one', selectedCaptureKinds: ['like'],
  });
  const mismatch = await runSync(first);
  assert.equal(mismatch.streams[0].errorCode, 'account_mismatch');
  assert.equal(mismatchBridge.calls.filter(({ operation }) => operation === 'collect').length, 0);

  const driftConnector = createXAsideConnector({
    browserBridge: {
      inspectIdentity: async () => ({ handle: 'reader_one' }),
      readSurface: async () => ({ items: [], cursor: 'nope', landmarks: [] }),
    },
  });
  const second = await context(t, driftConnector);
  configureAccount(second.db, second.registry, {
    connectorId: 'x-aside', identity: 'reader_one', profileRef: 'x-reader-one', selectedCaptureKinds: ['like'],
  });
  const drift = await runSync(second);
  assert.equal(drift.streams[0].errorCode, 'connector_drift');
  assert.equal(second.db.prepare('SELECT COUNT(*) AS count FROM sync_cursors').get().count, 0);
});

test('X Aside profile references and bridge output are injection-safe', async (t) => {
  const connector = createXAsideConnector({ browserBridge: fakeBridge() });
  const { db, registry } = await context(t, connector);
  assert.throws(() => configureAccount(db, registry, {
    connectorId: 'x-aside',
    identity: 'reader_one',
    profileRef: 'bad profile; command',
    selectedCaptureKinds: ['save'],
  }), /profile reference/i);
  assert.deepEqual(parseAsideXOutput('SOCIAL_MEMORY_JSON:{"handle":"safe"}\n'), { handle: 'safe' });
  assert.throws(() => parseAsideXOutput('SOCIAL_MEMORY_JSON:{}\nSOCIAL_MEMORY_JSON:{}'), /exactly one JSON marker/i);
});

test('X Aside bridge pins the subprocess account and uses structured bookmarks', async () => {
  const invocations = [];
  const browserBridge = createAsideXBridge({
    execFileImpl: async (command, args, options) => {
      invocations.push({ command, args, options });
      return { stdout: 'SOCIAL_MEMORY_JSON:{"handle":"reader_one"}\n', stderr: '' };
    },
  });
  await browserBridge.inspectIdentity({ profileRef: 'profile-one' });
  await browserBridge.readSurface({ profileRef: 'profile-one', surface: 'bookmarks', limit: 3 });

  assert.deepEqual(invocations[0].args.slice(0, 3), ['repl', '--account', 'profile-one']);
  assert.match(invocations[0].args[3], /twitter\.getMe/);
  assert.match(invocations[1].args[3], /twitter\.getBookmarks/);
  assert.equal(invocations[1].options.shell, false);
});
