import { validateCaptureKinds } from './capture-kinds.mjs';
import { normalizedIdentity, platformForConnector } from './platform.mjs';

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
    connectionId: row.id,
    identityId: row.identity_id,
    platform: db.prepare('SELECT platform FROM identities WHERE id=?').get(row.identity_id).platform,
    connectorId: row.connector_id,
    configuredIdentity: row.configured_identity,
    profileRef: row.profile_ref,
    authenticatedIdentity: row.authenticated_identity,
    status: row.status,
    connectorConfig: JSON.parse(row.config_json),
    selectedCaptureKinds: selectedKindsForAccount(db, row.id),
  };
}

function validateConnectorConfig(connector, value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('connectorConfig must be an object');
  }
  for (const key of Object.keys(value)) {
    if (/token|secret|password|cookie|authorization/i.test(key)) {
      throw new Error(`connectorConfig cannot store secret field: ${key}`);
    }
  }
  if (typeof connector.normalizeConfig === 'function') {
    return JSON.stringify(connector.normalizeConfig(value));
  }
  if (Object.keys(value).length > 0) {
    throw new Error(`Connector ${connector.id} does not accept connectorConfig`);
  }
  return '{}';
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

  const platform = connector.platform ?? platformForConnector(connector.id);
  const identity = normalizedIdentity(platform, input.identity);
  if (!identity) throw new Error('Account identity is required');
  if (typeof connector.normalizeProfileRef === 'function') {
    const existingProfileRef = db.prepare(`
      SELECT profile_ref
      FROM accounts
      WHERE connector_id = ? AND configured_identity = ?
    `).get(connector.id, identity)?.profile_ref;
    input = {
      ...input,
      profileRef: connector.normalizeProfileRef(input.profileRef ?? existingProfileRef),
    };
  }
  const connectorConfigJson = validateConnectorConfig(connector, input.connectorConfig);
  const now = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE');
  try {
    const platformIdentity = db.prepare(`
      INSERT INTO identities (platform, handle)
      VALUES (?, ?)
      ON CONFLICT(platform, handle) DO UPDATE SET handle = excluded.handle
      RETURNING id
    `).get(platform, identity);
    db.prepare(`
      INSERT INTO connectors (id, capabilities_json, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET capabilities_json = excluded.capabilities_json
    `).run(connector.id, JSON.stringify(connector.capabilities), now);

    const row = db.prepare(`
      INSERT INTO accounts (
        connector_id, configured_identity, profile_ref, status,
        config_json, created_at, updated_at, identity_id
      ) VALUES (?, ?, ?, 'unverified', ?, ?, ?, ?)
      ON CONFLICT(connector_id, configured_identity) DO UPDATE SET
        profile_ref = COALESCE(excluded.profile_ref, accounts.profile_ref),
        config_json = CASE
          WHEN ? IS NULL THEN accounts.config_json
          ELSE excluded.config_json
        END,
        updated_at = excluded.updated_at
      RETURNING *
    `).get(
      connector.id,
      identity,
      input.profileRef ?? null,
      connectorConfigJson ?? '{}',
      now,
      now,
      platformIdentity.id,
      connectorConfigJson ?? null,
    );

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

// Called by trusted local adapters, never directly by a page-supplied identity message.
export async function connectAccount(db, registry, input) {
  const connector = registry.get(input.connectorId);
  validateCaptureKinds(input.selectedCaptureKinds, connector.capabilities);
  validateConnectorConfig(connector, input.connectorConfig);
  const profileRef = typeof connector.normalizeProfileRef === 'function'
    ? connector.normalizeProfileRef(input.profileRef)
    : input.profileRef ?? null;
  const verification = await connector.verify({
    account: {
      connectorId: connector.id,
      profileRef,
      connectorConfig: input.connectorConfig ?? {},
    },
  });
  if (verification?.status !== 'ready' || !verification.authenticatedIdentity?.trim()) {
    const error = new Error('Connector could not verify the signed-in account');
    error.code = 'verification_failed';
    throw error;
  }
  const identity = normalizedIdentity(
    connector.platform ?? platformForConnector(connector.id),
    verification.authenticatedIdentity,
  );
  const result = configureAccount(db, registry, { ...input, identity, profileRef });
  db.prepare('UPDATE accounts SET status = ?, authenticated_identity = ? WHERE id = ?')
    .run('ready', identity, result.id);
  return { ...result, status: 'ready', authenticatedIdentity: identity };
}

export function listAccounts(db) {
  return db
    .prepare('SELECT * FROM accounts ORDER BY connector_id, configured_identity')
    .all()
    .map((row) => mapAccount(db, row));
}
