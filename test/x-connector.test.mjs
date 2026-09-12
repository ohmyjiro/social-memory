import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { configureAccount } from '../src/accounts.mjs';
import { initializeLibrary, loadConfig } from '../src/config.mjs';
import { createConnectorRegistry } from '../src/connectors/registry.mjs';
import {
  createKeychainCredentialProvider,
  createXConnector,
} from '../src/connectors/x.mjs';
import { openDatabase } from '../src/db.mjs';
import { runSync } from '../src/sync.mjs';

async function createContext(t, connector) {
  const dataDir = await mkdtemp(join(tmpdir(), 'social-memory-x-'));
  const config = loadConfig({ SOCIAL_MEMORY_DATA_DIR: dataDir });
  await initializeLibrary(config);
  const db = openDatabase(config.dbPath);
  t.after(() => db.close());
  const registry = createConnectorRegistry([connector]);
  return { config, db, registry };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('X connector verifies identity and keeps credentials outside account data', async (t) => {
  const requests = [];
  const connector = createXConnector({
    credentialProvider: async (account) => {
      assert.deepEqual(account.connectorConfig, { credentialEnv: 'X_TOKEN_READER' });
      return 'secret-test-token';
    },
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), authorization: options.headers.authorization });
      return jsonResponse({ data: { id: '42', username: 'reader_one', name: 'Reader One' } });
    },
  });
  const { db, registry } = await createContext(t, connector);
  const account = configureAccount(db, registry, {
    connectorId: 'x',
    identity: '@reader_one',
    selectedCaptureKinds: ['like', 'save'],
    connectorConfig: { credentialEnv: 'X_TOKEN_READER' },
  });

  const verified = await connector.verify({ account });

  assert.equal(verified.status, 'ready');
  assert.equal(verified.authenticatedIdentity, 'reader_one');
  assert.equal(verified.connectorState.userId, '42');
  assert.deepEqual(requests, [{
    url: 'https://api.x.com/2/users/me?user.fields=username%2Cname',
    authorization: 'Bearer secret-test-token',
  }]);
  assert.doesNotMatch(db.prepare('SELECT config_json FROM accounts').get().config_json, /secret-test-token/);
});

test('X account configuration accepts only a credential environment-variable name', async (t) => {
  const connector = createXConnector({
    credentialProvider: async () => 'unused',
    fetchImpl: async () => jsonResponse({}),
  });
  const { db, registry } = await createContext(t, connector);
  const base = {
    connectorId: 'x',
    identity: 'reader_one',
    selectedCaptureKinds: ['save'],
  };

  assert.throws(
    () => configureAccount(db, registry, { ...base, connectorConfig: { value: 'token-in-disguise' } }),
    /unknown X connector config/i,
  );
  assert.throws(
    () => configureAccount(db, registry, { ...base, connectorConfig: { credentialEnv: 'bad-name!' } }),
    /environment variable name/i,
  );
  const account = configureAccount(db, registry, {
    ...base,
    connectorConfig: { credentialEnv: 'X_TOKEN_READER' },
  });
  assert.deepEqual(account.connectorConfig, { credentialEnv: 'X_TOKEN_READER' });
});

test('X Keychain credential provider reads a secret without putting it in account config', async () => {
  const calls = [];
  const provider = createKeychainCredentialProvider({
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: 'secret-from-keychain\n', stderr: '' };
    },
  });

  const token = await provider({
    connectorConfig: {
      keychainService: 'social-memory.x',
      keychainAccount: 'reader@example.test',
    },
  });

  assert.equal(token, 'secret-from-keychain');
  assert.deepEqual(calls, [{
    command: 'security',
    args: ['find-generic-password', '-w', '-s', 'social-memory.x', '-a', 'reader@example.test'],
    options: { shell: false, timeout: 10_000 },
  }]);
});

test('X configuration accepts either environment or Keychain references, never both', async (t) => {
  const connector = createXConnector({
    credentialProvider: async () => 'unused',
    fetchImpl: async () => jsonResponse({}),
  });
  const { db, registry } = await createContext(t, connector);
  const base = {
    connectorId: 'x',
    identity: 'reader_one',
    selectedCaptureKinds: ['save'],
  };

  const keychainAccount = configureAccount(db, registry, {
    ...base,
    connectorConfig: {
      keychainService: 'social-memory.x',
      keychainAccount: 'reader@example.test',
    },
  });
  assert.deepEqual(keychainAccount.connectorConfig, {
    keychainService: 'social-memory.x',
    keychainAccount: 'reader@example.test',
  });
  assert.throws(
    () => configureAccount(db, registry, {
      ...base,
      connectorConfig: {
        credentialEnv: 'X_TOKEN_READER',
        keychainService: 'social-memory.x',
        keychainAccount: 'reader@example.test',
      },
    }),
    /either environment or Keychain/i,
  );
});

test('X sync calls separate like and bookmark endpoints and preserves native kinds', async (t) => {
  const requestedPaths = [];
  const connector = createXConnector({
    credentialProvider: async () => 'secret-test-token',
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      requestedPaths.push(`${parsed.pathname}?${parsed.searchParams}`);
      if (parsed.pathname === '/2/users/me') {
        return jsonResponse({ data: { id: '42', username: 'reader_one', name: 'Reader One' } });
      }
      return jsonResponse({
        data: [{
          id: '1001',
          text: 'Shared X source about retention',
          author_id: '7',
          created_at: '2026-08-01T01:02:03.000Z',
        }],
        includes: { users: [{ id: '7', username: 'author_one', name: 'Author One' }] },
        meta: { next_token: parsed.pathname.endsWith('bookmarks') ? 'save-next' : 'like-next' },
      });
    },
  });
  const { config, db, registry } = await createContext(t, connector);
  configureAccount(db, registry, {
    connectorId: 'x',
    identity: 'reader_one',
    selectedCaptureKinds: ['like', 'save'],
    connectorConfig: { credentialEnv: 'X_TOKEN_READER' },
  });

  const summary = await runSync({ db, config, registry, limit: 25 });

  assert.equal(summary.status, 'success');
  assert.ok(requestedPaths.some((path) => path.startsWith('/2/users/42/liked_tweets?')));
  assert.ok(requestedPaths.some((path) => path.startsWith('/2/users/42/bookmarks?')));
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sources').get().count, 1);
  assert.deepEqual(
    db.prepare('SELECT kind, native_kind FROM captures ORDER BY kind').all().map((row) => ({ ...row })),
    [
      { kind: 'like', native_kind: 'favorite' },
      { kind: 'save', native_kind: 'bookmark' },
    ],
  );
  assert.deepEqual(
    db.prepare('SELECT kind, cursor FROM sync_cursors ORDER BY kind').all().map((row) => ({ ...row })),
    [
      { kind: 'like', cursor: 'like-next' },
      { kind: 'save', cursor: 'save-next' },
    ],
  );
});

test('X pagination cursor is sent only to its own capture-kind request', async (t) => {
  const collectionUrls = [];
  const connector = createXConnector({
    credentialProvider: async () => 'secret-test-token',
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/2/users/me') {
        return jsonResponse({ data: { id: '42', username: 'reader_one' } });
      }
      collectionUrls.push(parsed);
      return jsonResponse({ data: [], meta: {} });
    },
  });
  const { db, registry } = await createContext(t, connector);
  const account = configureAccount(db, registry, {
    connectorId: 'x',
    identity: 'reader_one',
    selectedCaptureKinds: ['save'],
    connectorConfig: { credentialEnv: 'X_TOKEN_READER' },
  });
  const verification = await connector.verify({ account });

  await connector.collect({
    account,
    kind: 'save',
    cursor: 'save-cursor-only',
    limit: 10,
    verification,
  });

  assert.equal(collectionUrls[0].searchParams.get('pagination_token'), 'save-cursor-only');
});

test('X authentication errors are reduced to a safe reauthentication code', async () => {
  const connector = createXConnector({
    credentialProvider: async () => 'expired-token',
    fetchImpl: async () => jsonResponse({ detail: 'private upstream detail' }, 401),
  });

  await assert.rejects(
    connector.verify({ account: { connectorConfig: {}, configuredIdentity: 'reader_one' } }),
    (error) => error.code === 'reauth_required' && !error.message.includes('private upstream detail'),
  );
});
