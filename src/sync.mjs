import { listAccounts } from './accounts.mjs';
import { ingestCaptureBatch } from './ingest.mjs';

function normalizeIdentity(value) {
  return String(value ?? '').trim().replace(/^@/, '').toLocaleLowerCase('en-US');
}

function isoNow(clock) {
  const value = clock();
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function safeErrorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : 'connector_error';
  return /^[a-z0-9_]+$/i.test(code) ? code : 'connector_error';
}

function insertRun(db, accountId, kind, startedAt) {
  return db.prepare(`
    INSERT INTO collection_runs (account_id, kind, started_at, status)
    VALUES (?, ?, ?, 'running')
    RETURNING id
  `).get(accountId, kind, startedAt).id;
}

function finishRun(db, runId, { finishedAt, status, itemCount = 0, errorCode = null, detail = {} }) {
  db.prepare(`
    UPDATE collection_runs
    SET finished_at = ?, status = ?, item_count = ?, error_code = ?, detail_json = ?
    WHERE id = ?
  `).run(finishedAt, status, itemCount, errorCode, JSON.stringify(detail), runId);
}

function matchesFilters(account, kind, filters = {}) {
  if (filters.connectorId && filters.connectorId !== account.connectorId) return false;
  if (filters.accountId && Number(filters.accountId) !== account.id) return false;
  if (filters.kind && filters.kind !== kind) return false;
  return true;
}

function overallStatus(streams) {
  if (streams.length === 0) return 'no_streams';
  if (streams.every(({ status }) => status === 'success')) return 'success';
  if (streams.every(({ status }) => status === 'failed')) return 'failed';
  return 'partial';
}

export async function runSync({
  db,
  config,
  registry,
  filters = {},
  limit = 100,
  trigger = 'manual',
  clock = () => new Date(),
}) {
  if (!['manual', 'scheduled'].includes(trigger)) throw new Error(`Unknown sync trigger: ${trigger}`);
  const streams = [];

  for (const account of listAccounts(db)) {
    const selectedKinds = account.selectedCaptureKinds.filter((kind) =>
      matchesFilters(account, kind, filters));
    if (selectedKinds.length === 0) continue;

    const connector = registry.get(account.connectorId);
    let verification;
    try {
      verification = await connector.verify({ account });
    } catch (error) {
      verification = {
        status: 'verification_failed',
        configuredIdentity: account.configuredIdentity,
        authenticatedIdentity: null,
        errorCode: safeErrorCode(error),
      };
    }

    const configuredIdentity = verification.configuredIdentity ?? account.configuredIdentity;
    const authenticatedIdentity = verification.authenticatedIdentity ?? null;
    const identitiesMatch =
      verification.status === 'ready' &&
      normalizeIdentity(configuredIdentity) === normalizeIdentity(authenticatedIdentity);
    const accountStatus = identitiesMatch
      ? 'ready'
      : verification.status === 'ready'
        ? 'account_mismatch'
        : verification.status;

    db.prepare(`
      UPDATE accounts
      SET authenticated_identity = ?, status = ?, updated_at = ?
      WHERE id = ?
    `).run(authenticatedIdentity, accountStatus, isoNow(clock), account.id);

    if (!identitiesMatch) {
      const errorCode = accountStatus === 'account_mismatch'
        ? 'account_mismatch'
        : verification.errorCode ?? 'verification_failed';
      for (const kind of selectedKinds) {
        const startedAt = isoNow(clock);
        const runId = insertRun(db, account.id, kind, startedAt);
        finishRun(db, runId, {
          finishedAt: isoNow(clock),
          status: 'failed',
          errorCode,
          detail: { configuredIdentity, authenticatedIdentity },
        });
        streams.push({
          accountId: account.id,
          connectorId: account.connectorId,
          kind,
          status: 'failed',
          count: 0,
          errorCode,
        });
      }
      continue;
    }

    for (const kind of selectedKinds) {
      const startedAt = isoNow(clock);
      const runId = insertRun(db, account.id, kind, startedAt);
      const currentCursor = db.prepare(`
        SELECT cursor FROM sync_cursors WHERE account_id = ? AND kind = ?
      `).get(account.id, kind)?.cursor ?? null;

      try {
        const collected = await connector.collect({
          account,
          kind,
          cursor: currentCursor,
          limit,
          verification,
        });
        if (!collected || !Array.isArray(collected.events)) {
          const error = new Error('Connector returned an invalid result');
          error.code = 'connector_drift';
          throw error;
        }
        if (collected.nextCursor !== null && typeof collected.nextCursor !== 'string') {
          const error = new Error('Connector returned an invalid cursor');
          error.code = 'connector_drift';
          throw error;
        }

        await ingestCaptureBatch(db, config, account, kind, collected.events);
        db.prepare(`
          INSERT INTO sync_cursors (account_id, kind, cursor, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(account_id, kind) DO UPDATE SET
            cursor = excluded.cursor,
            updated_at = excluded.updated_at
        `).run(account.id, kind, collected.nextCursor, isoNow(clock));
        finishRun(db, runId, {
          finishedAt: isoNow(clock),
          status: 'success',
          itemCount: collected.events.length,
        });
        if (trigger === 'manual') {
          db.prepare(`
            INSERT INTO manual_sync_receipts (
              account_id, kind, connector_id, authenticated_identity, success_at, run_id
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(account_id, kind) DO UPDATE SET
              connector_id = excluded.connector_id,
              authenticated_identity = excluded.authenticated_identity,
              success_at = excluded.success_at,
              run_id = excluded.run_id
          `).run(
            account.id,
            kind,
            account.connectorId,
            authenticatedIdentity,
            isoNow(clock),
            runId,
          );
        }
        streams.push({
          accountId: account.id,
          connectorId: account.connectorId,
          kind,
          status: 'success',
          count: collected.events.length,
          errorCode: null,
        });
      } catch (error) {
        const errorCode = safeErrorCode(error);
        finishRun(db, runId, {
          finishedAt: isoNow(clock),
          status: 'failed',
          errorCode,
          detail: { message: 'Connector stream failed' },
        });
        streams.push({
          accountId: account.id,
          connectorId: account.connectorId,
          kind,
          status: 'failed',
          count: 0,
          errorCode,
        });
      }
    }
  }

  return { status: overallStatus(streams), streams };
}
