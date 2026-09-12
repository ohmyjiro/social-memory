import { createHash } from 'node:crypto';

import { CAPTURE_KINDS } from './capture-kinds.mjs';
import { storeObject } from './evidence-store.mjs';

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalTimestamp(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field} must be a valid timestamp`);
  }
  return new Date(value).toISOString();
}

function optionalUrl(value, field) {
  if (value === null || value === undefined) return null;
  try {
    return new URL(value).href;
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }
}

function validateEvent(event, streamKind) {
  if (!event || typeof event !== 'object') throw new Error('Capture event must be an object');
  const externalId = requireString(event.externalId, 'externalId');
  const captureKind = requireString(event.capture?.kind, 'capture.kind');
  if (!CAPTURE_KINDS.includes(captureKind)) throw new Error(`Unknown capture kind: ${captureKind}`);
  if (captureKind !== streamKind) {
    throw new Error(`Capture kind ${captureKind} does not match stream ${streamKind}`);
  }

  const evidence = event.evidence ?? [];
  if (!Array.isArray(evidence)) throw new Error('evidence must be an array');
  for (const item of evidence) {
    requireString(item.kind, 'evidence.kind');
    requireString(item.provenance, 'evidence.provenance');
    if (item.kind === 'file') requireString(item.filePath, 'evidence.filePath');
    if (item.kind === 'text') requireString(item.text, 'evidence.text');
  }

  return {
    externalId,
    canonicalUrl: optionalUrl(event.canonicalUrl, 'canonicalUrl'),
    authorHandle: event.author?.handle?.trim() || null,
    authorName: event.author?.name?.trim() || null,
    text: typeof event.text === 'string' ? event.text : null,
    sourceCreatedAt: optionalTimestamp(event.sourceCreatedAt, 'sourceCreatedAt'),
    nativeKind: requireString(event.capture?.nativeKind, 'capture.nativeKind'),
    capturedAt: optionalTimestamp(event.capture?.capturedAt, 'capture.capturedAt'),
    evidence,
    rawJson: JSON.stringify(event.raw ?? {}),
  };
}

function evidenceKey(item, object) {
  return createHash('sha256')
    .update(JSON.stringify({
      kind: item.kind,
      text: item.text ?? null,
      objectSha256: object?.sha256 ?? null,
      sourceUrl: item.sourceUrl ?? null,
      provenance: item.provenance,
    }))
    .digest('hex');
}

export async function ingestCaptureBatch(db, config, account, kind, events) {
  if (!account.selectedCaptureKinds.includes(kind)) {
    throw new Error(`Capture kind ${kind} is not selected for account ${account.id}`);
  }
  if (!Array.isArray(events)) throw new Error('events must be an array');

  const normalized = events.map((event) => validateEvent(event, kind));
  for (const event of normalized) {
    event.preparedEvidence = [];
    for (const item of event.evidence) {
      const object = item.kind === 'file' ? await storeObject(config, item.filePath) : null;
      event.preparedEvidence.push({ item, object, dedupeKey: evidenceKey(item, object) });
    }
  }

  const result = {
    insertedSources: 0,
    insertedCaptures: 0,
    updatedCaptures: 0,
    insertedEvidence: 0,
    storedObjects: 0,
  };
  const observedAt = new Date().toISOString();

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const event of normalized) {
      const existingSource = db
        .prepare('SELECT id FROM sources WHERE connector_id = ? AND external_id = ?')
        .get(account.connectorId, event.externalId);
      const source = db.prepare(`
        INSERT INTO sources (
          connector_id, external_id, canonical_url, author_handle, author_name,
          text, source_created_at, first_collected_at, last_seen_at, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(connector_id, external_id) DO UPDATE SET
          canonical_url = COALESCE(excluded.canonical_url, sources.canonical_url),
          author_handle = COALESCE(excluded.author_handle, sources.author_handle),
          author_name = COALESCE(excluded.author_name, sources.author_name),
          text = COALESCE(excluded.text, sources.text),
          source_created_at = COALESCE(excluded.source_created_at, sources.source_created_at),
          last_seen_at = excluded.last_seen_at,
          raw_json = excluded.raw_json
        RETURNING id
      `).get(
        account.connectorId,
        event.externalId,
        event.canonicalUrl,
        event.authorHandle,
        event.authorName,
        event.text,
        event.sourceCreatedAt,
        observedAt,
        observedAt,
        event.rawJson,
      );
      if (!existingSource) result.insertedSources += 1;

      const existingCapture = db.prepare(`
        SELECT id FROM captures WHERE account_id = ? AND source_id = ? AND kind = ?
      `).get(account.id, source.id, kind);
      db.prepare(`
        INSERT INTO captures (
          account_id, source_id, kind, native_kind, captured_at,
          first_observed_at, last_observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, source_id, kind) DO UPDATE SET
          native_kind = excluded.native_kind,
          captured_at = COALESCE(excluded.captured_at, captures.captured_at),
          last_observed_at = excluded.last_observed_at
      `).run(
        account.id,
        source.id,
        kind,
        event.nativeKind,
        event.capturedAt,
        observedAt,
        observedAt,
      );
      if (existingCapture) result.updatedCaptures += 1;
      else result.insertedCaptures += 1;

      for (const prepared of event.preparedEvidence) {
        const { item, object, dedupeKey } = prepared;
        if (object) {
          const objectInsert = db.prepare(`
            INSERT OR IGNORE INTO objects (
              sha256, byte_size, mime_type, object_path, created_at
            ) VALUES (?, ?, ?, ?, ?)
          `).run(
            object.sha256,
            object.byteSize,
            item.mimeType ?? null,
            object.objectPath,
            observedAt,
          );
          result.storedObjects += Number(objectInsert.changes);
        }

        const evidenceInsert = db.prepare(`
          INSERT OR IGNORE INTO evidence (
            source_id, dedupe_key, kind, text, object_sha256, source_url,
            original_filename, mime_type, provenance, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          source.id,
          dedupeKey,
          item.kind,
          item.text ?? null,
          object?.sha256 ?? null,
          optionalUrl(item.sourceUrl, 'evidence.sourceUrl'),
          object?.originalFilename ?? null,
          item.mimeType ?? null,
          item.provenance,
          observedAt,
        );
        result.insertedEvidence += Number(evidenceInsert.changes);
      }

      const evidenceText = db.prepare(`
        SELECT COALESCE(group_concat(text, char(10)), '') AS text
        FROM evidence
        WHERE source_id = ? AND text IS NOT NULL
      `).get(source.id).text;
      db.prepare('UPDATE sources SET evidence_text = ? WHERE id = ?').run(evidenceText, source.id);
    }

    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
