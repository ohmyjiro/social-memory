import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { configureAccount, listAccounts } from '../src/accounts.mjs';
import { initializeLibrary, loadConfig } from '../src/config.mjs';
import { createConnectorRegistry } from '../src/connectors/registry.mjs';
import { fixtureConnector } from '../src/connectors/fixture.mjs';
import { openDatabase } from '../src/db.mjs';

async function createTestContext(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'social-memory-accounts-'));
  const config = loadConfig({ SOCIAL_MEMORY_DATA_DIR: dataDir });
  await initializeLibrary(config);
  const db = openDatabase(config.dbPath);
  t.after(() => db.close());
  return { db, registry: createConnectorRegistry([fixtureConnector]) };
}

test('fixture declares distinct like, save, and repost capabilities', () => {
  assert.deepEqual(fixtureConnector.capabilities, ['like', 'save', 'repost']);
});

test('account setup requires an explicit valid capture selection', async (t) => {
  const { db, registry } = await createTestContext(t);
  const base = { connectorId: 'fixture', identity: 'reader_one' };

  assert.throws(
    () => configureAccount(db, registry, { ...base, selectedCaptureKinds: [] }),
    /select at least one/i,
  );
  assert.throws(
    () => configureAccount(db, registry, { ...base, selectedCaptureKinds: ['like', 'like'] }),
    /duplicate/i,
  );
  assert.throws(
    () => configureAccount(db, registry, { ...base, selectedCaptureKinds: ['heart'] }),
    /unknown/i,
  );
  assert.throws(
    () => configureAccount(db, registry, { ...base, selectedCaptureKinds: ['manual'] }),
    /does not support/i,
  );
});

test('account configuration rejects secret-shaped connector data', async (t) => {
  const { db, registry } = await createTestContext(t);
  const base = {
    connectorId: 'fixture',
    identity: 'reader_one',
    selectedCaptureKinds: ['save'],
  };

  assert.throws(
    () => configureAccount(db, registry, {
      ...base,
      connectorConfig: { accessToken: 'must-not-be-stored' },
    }),
    /cannot store|does not accept/i,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM accounts').get().count, 0);
});

test('account selection keeps like and save distinct and follows canonical order', async (t) => {
  const { db, registry } = await createTestContext(t);

  const account = configureAccount(db, registry, {
    connectorId: 'fixture',
    identity: '@reader_one',
    profileRef: 'fixture-profile-one',
    selectedCaptureKinds: ['save', 'like'],
  });

  assert.deepEqual(account.selectedCaptureKinds, ['like', 'save']);
  assert.equal(account.configuredIdentity, '@reader_one');
  assert.deepEqual(listAccounts(db), [account]);
});

test('reconfiguration changes future selection without deleting old captures', async (t) => {
  const { db, registry } = await createTestContext(t);
  const account = configureAccount(db, registry, {
    connectorId: 'fixture',
    identity: 'reader_one',
    selectedCaptureKinds: ['like', 'save'],
  });
  const now = '2026-09-13T00:00:00.000Z';
  const source = db.prepare(`
    INSERT INTO sources (
      connector_id, external_id, canonical_url, text,
      first_collected_at, last_seen_at, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    RETURNING id
  `).get('fixture', 'shared-post', 'https://example.test/shared-post', 'Shared post', now, now, '{}');
  db.prepare(`
    INSERT INTO captures (
      account_id, source_id, kind, native_kind,
      first_observed_at, last_observed_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(account.id, source.id, 'save', 'bookmark', now, now);

  const reconfigured = configureAccount(db, registry, {
    connectorId: 'fixture',
    identity: 'reader_one',
    selectedCaptureKinds: ['like'],
  });

  assert.deepEqual(reconfigured.selectedCaptureKinds, ['like']);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM captures').get().count, 1);
  assert.equal(db.prepare('SELECT kind FROM captures').get().kind, 'save');
});
