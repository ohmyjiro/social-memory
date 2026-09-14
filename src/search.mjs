import { CAPTURE_KINDS } from './capture-kinds.mjs';

function boundedLimit(value) {
  const parsed = Number(value ?? 20);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error('limit must be a positive integer');
  return Math.min(parsed, 100);
}

function ftsExpression(query) {
  const tokens = String(query ?? '').match(/[\p{L}\p{N}_]+/gu) ?? [];
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' AND ');
}

function captureRows(db, sourceId, accountId) {
  const clauses = ['source_id = ?'];
  const params = [sourceId];
  if (accountId !== undefined && accountId !== null) {
    clauses.push('account_id = ?');
    params.push(Number(accountId));
  }
  return db.prepare(`
    SELECT account_id, kind, native_kind, captured_at, first_observed_at, last_observed_at
    FROM captures
    WHERE ${clauses.join(' AND ')}
    ORDER BY CASE kind
      WHEN 'like' THEN 1 WHEN 'save' THEN 2 WHEN 'repost' THEN 3 WHEN 'manual' THEN 4
    END, account_id
  `).all(...params);
}

function mapSummary(db, row, accountId) {
  const captures = captureRows(db, row.id, accountId);
  return {
    id: row.id,
    platform: row.platform,
    connectorId: row.connector_id,
    externalId: row.external_id,
    canonicalUrl: row.canonical_url,
    author: {
      handle: row.author_handle,
      name: row.author_name,
    },
    excerpt: row.text?.slice(0, 280) ?? '',
    sourceCreatedAt: row.source_created_at,
    lastSeenAt: row.last_seen_at,
    captureKinds: [...new Set(captures.map(({ kind }) => kind))],
    nativeKinds: [...new Set(captures.map(({ native_kind }) => native_kind))],
  };
}

export function searchSources(db, options = {}) {
  const query = String(options.query ?? '').trim();
  const expression = ftsExpression(query);
  if (query && !expression) return [];

  const joins = [];
  const clauses = [];
  const params = [];
  if (expression) {
    joins.push('JOIN sources_fts ON sources_fts.rowid = sources.id');
    clauses.push('sources_fts MATCH ?');
    params.push(expression);
  }
  const captureClauses = [];
  const captureParams = [];
  if (options.connectorId) {
    captureClauses.push('filtered_accounts.connector_id = ?');
    captureParams.push(options.connectorId);
  }
  if (options.accountId !== undefined && options.accountId !== null) {
    captureClauses.push('filtered_captures.account_id = ?');
    captureParams.push(Number(options.accountId));
  }
  if (options.kinds !== undefined) {
    if (!Array.isArray(options.kinds) || options.kinds.length === 0) {
      throw new Error('kinds must be a non-empty array');
    }
    for (const kind of options.kinds) {
      if (!CAPTURE_KINDS.includes(kind)) throw new Error(`Unknown capture kind: ${kind}`);
    }
    captureClauses.push(`filtered_captures.kind IN (${options.kinds.map(() => '?').join(', ')})`);
    captureParams.push(...options.kinds);
  }
  if (captureClauses.length > 0) {
    clauses.push(`EXISTS (
      SELECT 1
      FROM captures filtered_captures
      JOIN accounts filtered_accounts ON filtered_accounts.id = filtered_captures.account_id
      WHERE filtered_captures.source_id = sources.id
        AND ${captureClauses.join(' AND ')}
    )`);
    params.push(...captureParams);
  }
  if (options.since) {
    const timestamp = Date.parse(options.since);
    if (!Number.isFinite(timestamp)) throw new Error('since must be a valid ISO date');
    clauses.push('sources.source_created_at >= ?');
    params.push(new Date(timestamp).toISOString());
  }

  const limit = boundedLimit(options.limit);
  const order = expression
    ? 'bm25(sources_fts), COALESCE(sources.source_created_at, sources.last_seen_at) DESC, sources.id DESC'
    : 'COALESCE(sources.source_created_at, sources.last_seen_at) DESC, sources.id DESC';
  const rows = db.prepare(`
    SELECT sources.*
    FROM sources
    ${joins.join('\n')}
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY ${order}
    LIMIT ?
  `).all(...params, limit);

  return rows.map((row) => mapSummary(db, row, options.accountId));
}

export function getSource(db, sourceId) {
  const row = db.prepare(`
    SELECT * FROM sources WHERE id = ?
  `).get(Number(sourceId));
  if (!row) return null;

  const captures = captureRows(db, row.id).map((capture) => ({
    accountId: capture.account_id,
    kind: capture.kind,
    nativeKind: capture.native_kind,
    capturedAt: capture.captured_at,
    firstObservedAt: capture.first_observed_at,
    lastObservedAt: capture.last_observed_at,
  }));
  const evidence = db.prepare(`
    SELECT id, kind, text, object_sha256, source_url, original_filename,
           mime_type, parent_evidence_id, provenance, created_at
    FROM evidence
    WHERE source_id = ?
    ORDER BY id
  `).all(row.id).map((item) => ({
    id: item.id,
    kind: item.kind,
    text: item.text,
    objectSha256: item.object_sha256,
    sourceUrl: item.source_url,
    originalFilename: item.original_filename,
    mimeType: item.mime_type,
    parentEvidenceId: item.parent_evidence_id,
    provenance: item.provenance,
    createdAt: item.created_at,
  }));

  return {
    id: row.id,
    platform: row.platform,
    connectorId: row.connector_id,
    externalId: row.external_id,
    canonicalUrl: row.canonical_url,
    author: { handle: row.author_handle, name: row.author_name },
    text: row.text,
    sourceCreatedAt: row.source_created_at,
    firstCollectedAt: row.first_collected_at,
    lastSeenAt: row.last_seen_at,
    availability: row.availability,
    captures,
    evidence,
  };
}
