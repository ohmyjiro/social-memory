import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { configureAccount } from '../src/accounts.mjs';
import { initializeLibrary, loadConfig } from '../src/config.mjs';
import { createConnectorRegistry } from '../src/connectors/registry.mjs';
import { openDatabase } from '../src/db.mjs';
import { runSync } from '../src/sync.mjs';

async function createTestContext(t, connector) {
  const dataDir = await mkdtemp(join(tmpdir(), 'social-memory-sync-'));
  const config = loadConfig({ SOCIAL_MEMORY_DATA_DIR: dataDir });
  await initializeLibrary(config);
  const db = openDatabase(config.dbPath);
  t.after(() => db.close());
  return { config, db, registry: createConnectorRegistry([connector]) };
}

function createObservedConnector({ calls, verificationCalls, failKind, authenticatedIdentity } = {}) {
  return {
    id: 'fixture',
    capabilities: ['like', 'save', 'repost'],
    async verify({ account }) {
      verificationCalls?.push(account.configuredIdentity);
      return {
        status: 'ready',
        configuredIdentity: account.configuredIdentity,
        authenticatedIdentity: authenticatedIdentity ?? account.configuredIdentity,
      };
    },
    async collect({ account, kind, cursor }) {
      calls?.push({ identity: account.configuredIdentity, kind, cursor });
      if (kind === failKind) {
        const error = new Error('synthetic connector failure');
        error.code = 'fixture_failure';
        throw error;
      }
      return { events: [], nextCursor: `${account.configuredIdentity}:${kind}:next` };
    },
  };
}

test('sync calls exactly the capture kinds selected for each account', async (t) => {
  const calls = [];
  const connector = createObservedConnector({ calls });
  const { config, db, registry } = await createTestContext(t, connector);
  configureAccount(db, registry, {
    connectorId: 'fixture',
    identity: 'reader_one',
    selectedCaptureKinds: ['save', 'like'],
  });
  configureAccount(db, registry, {
    connectorId: 'fixture',
    identity: 'reader_two',
    selectedCaptureKinds: ['repost'],
  });

  const summary = await runSync({ db, config, registry });

  assert.equal(summary.status, 'success');
  assert.deepEqual(calls, [
    { identity: 'reader_one', kind: 'like', cursor: null },
    { identity: 'reader_one', kind: 'save', cursor: null },
    { identity: 'reader_two', kind: 'repost', cursor: null },
  ]);
  assert.deepEqual(summary.streams.map(({ kind, status }) => ({ kind, status })), [
    { kind: 'like', status: 'success' },
    { kind: 'save', status: 'success' },
    { kind: 'repost', status: 'success' },
  ]);
});

test('a failed stream cannot advance its cursor or roll back another kind', async (t) => {
  const connector = createObservedConnector({ failKind: 'save' });
  const { config, db, registry } = await createTestContext(t, connector);
  const account = configureAccount(db, registry, {
    connectorId: 'fixture',
    identity: 'reader_one',
    selectedCaptureKinds: ['like', 'save'],
  });

  const summary = await runSync({ db, config, registry });
  const cursors = db.prepare(`
    SELECT kind, cursor FROM sync_cursors WHERE account_id = ? ORDER BY kind
  `).all(account.id).map((row) => ({ ...row }));

  assert.equal(summary.status, 'partial');
  assert.deepEqual(cursors, [{ kind: 'like', cursor: 'reader_one:like:next' }]);
  assert.deepEqual(summary.streams.map(({ kind, status, errorCode }) => ({ kind, status, errorCode })), [
    { kind: 'like', status: 'success', errorCode: null },
    { kind: 'save', status: 'failed', errorCode: 'fixture_failure' },
  ]);
});

test('identity mismatch fails closed before any collection call', async (t) => {
  const calls = [];
  const connector = createObservedConnector({ calls, authenticatedIdentity: '@different_reader' });
  const { config, db, registry } = await createTestContext(t, connector);
  const account = configureAccount(db, registry, {
    connectorId: 'fixture',
    identity: '@reader_one',
    selectedCaptureKinds: ['like', 'save'],
  });

  const summary = await runSync({ db, config, registry });
  const storedAccount = db.prepare(`
    SELECT configured_identity, authenticated_identity, status
    FROM accounts WHERE id = ?
  `).get(account.id);

  assert.deepEqual(calls, []);
  assert.equal(summary.status, 'failed');
  assert.deepEqual({ ...storedAccount }, {
    configured_identity: '@reader_one',
    authenticated_identity: '@different_reader',
    status: 'account_mismatch',
  });
  assert.equal(summary.streams.length, 2);
  assert.ok(summary.streams.every((stream) => stream.errorCode === 'account_mismatch'));
});

test('sync with no matching streams is not reported as success', async (t) => {
  const connector = createObservedConnector();
  const { config, db, registry } = await createTestContext(t, connector);

  const summary = await runSync({ db, config, registry });

  assert.deepEqual(summary, { status: 'no_streams', streams: [] });
});

test('an invalid sync limit is rejected before account verification', async (t) => {
  const verificationCalls = [];
  const connector = createObservedConnector({ verificationCalls });
  const { config, db, registry } = await createTestContext(t, connector);
  configureAccount(db, registry, {
    connectorId: 'fixture',
    identity: 'reader_one',
    selectedCaptureKinds: ['like'],
  });

  await assert.rejects(
    runSync({ db, config, registry, limit: 'not-a-number' }),
    /limit must be a positive integer/i,
  );
  assert.deepEqual(verificationCalls, []);
});
