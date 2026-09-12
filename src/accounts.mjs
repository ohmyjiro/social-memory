import { validateCaptureKinds } from './capture-kinds.mjs';

function selectedKindsForAccount(db, accountId) {
  return db
    .prepare(`
      SELECT kind
      FROM account_capture_kinds
      WHERE account_id = ?
      ORDER BY CASE kind
        WHEN 'like' THEN 1
        WHEN 'save' THEN 2
        WHEN 'repost' THEN 3
        WHEN 'manual' THEN 4
      END
    `)
    .all(accountId)
    .map(({ kind }) => kind);
}

function mapAccount(db, row) {
  return {
    id: row.id,
    connectorId: row.connector_id,
    configuredIdentity: row.configured_identity,
    profileRef: row.profile_ref,
    authenticatedIdentity: row.authenticated_identity,
    status: row.status,
    selectedCaptureKinds: selectedKindsForAccount(db, row.id),
  };
}

export function configureAccount(db, registry, input) {
  const connector = registry.get(input.connectorId);
  const selectedCaptureKinds = validateCaptureKinds(
    input.selectedCaptureKinds,
    connector.capabilities,
  );
  if (typeof input.identity !== 'string' || input.identity.trim().length === 0) {
    throw new Error('Account identity is required');
  }

  const identity = input.identity.trim();
  const now = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO connectors (id, capabilities_json, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET capabilities_json = excluded.capabilities_json
    `).run(connector.id, JSON.stringify(connector.capabilities), now);

    const row = db.prepare(`
      INSERT INTO accounts (
        connector_id, configured_identity, profile_ref, status,
        config_json, created_at, updated_at
      ) VALUES (?, ?, ?, 'unverified', '{}', ?, ?)
      ON CONFLICT(connector_id, configured_identity) DO UPDATE SET
        profile_ref = COALESCE(excluded.profile_ref, accounts.profile_ref),
        updated_at = excluded.updated_at
      RETURNING *
    `).get(connector.id, identity, input.profileRef ?? null, now, now);

    db.prepare('DELETE FROM account_capture_kinds WHERE account_id = ?').run(row.id);
    const insertKind = db.prepare(
      'INSERT INTO account_capture_kinds (account_id, kind) VALUES (?, ?)',
    );
    for (const kind of selectedCaptureKinds) insertKind.run(row.id, kind);

    db.exec('COMMIT');
    return mapAccount(db, row);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function listAccounts(db) {
  return db
    .prepare('SELECT * FROM accounts ORDER BY connector_id, configured_identity')
    .all()
    .map((row) => mapAccount(db, row));
}
