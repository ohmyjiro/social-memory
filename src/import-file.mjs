import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import { configureAccount } from './accounts.mjs';
import { CAPTURE_KINDS } from './capture-kinds.mjs';
import { ingestCaptureBatch, normalizeCaptureEvent } from './ingest.mjs';

function requireObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

async function resolveEvidencePath(importRoot, requestedPath) {
  if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
    throw new Error('Evidence path must be a non-empty string');
  }
  if (isAbsolute(requestedPath)) throw new Error('Evidence path cannot escape the import directory');
  const candidate = resolve(importRoot, requestedPath);
  const lexicalRelative = relative(importRoot, candidate);
  if (lexicalRelative.startsWith('..') || isAbsolute(lexicalRelative)) {
    throw new Error('Evidence path cannot escape the import directory');
  }

  const [realRoot, realCandidate] = await Promise.all([realpath(importRoot), realpath(candidate)]);
  const physicalRelative = relative(realRoot, realCandidate);
  if (physicalRelative.startsWith('..') || isAbsolute(physicalRelative)) {
    throw new Error('Evidence path cannot escape the import directory');
  }
  const details = await stat(realCandidate);
  if (!details.isFile()) throw new Error(`Evidence path is not a regular file: ${requestedPath}`);
  return realCandidate;
}

async function normalizeImportedCapture(capture, importRoot, selectedKinds) {
  requireObject(capture, 'capture');
  requireObject(capture.source, 'capture.source');
  if (!CAPTURE_KINDS.includes(capture.kind)) throw new Error(`Unknown capture kind: ${capture.kind}`);
  if (!selectedKinds.includes(capture.kind)) {
    throw new Error(`Capture kind ${capture.kind} is not included for this import`);
  }

  const evidence = [];
  if (!Array.isArray(capture.evidence ?? [])) throw new Error('capture.evidence must be an array');
  for (const item of capture.evidence ?? []) {
    requireObject(item, 'evidence item');
    if (item.kind === 'file') {
      evidence.push({
        kind: 'file',
        filePath: await resolveEvidencePath(importRoot, item.path),
        mimeType: item.mimeType,
        provenance: item.provenance,
        sourceUrl: item.sourceUrl,
      });
    } else if (item.kind === 'text') {
      evidence.push({
        kind: 'text',
        text: item.text,
        provenance: item.provenance,
        sourceUrl: item.sourceUrl,
      });
    } else {
      throw new Error(`Unsupported evidence kind: ${item.kind}`);
    }
  }

  const event = {
    externalId: capture.source.externalId,
    canonicalUrl: capture.source.canonicalUrl,
    author: capture.source.author,
    text: capture.source.text,
    sourceCreatedAt: capture.source.sourceCreatedAt,
    capture: {
      kind: capture.kind,
      nativeKind: capture.nativeKind,
      capturedAt: capture.capturedAt,
    },
    evidence,
  };
  normalizeCaptureEvent(event, capture.kind);
  return event;
}

export async function importCaptureFile({
  db,
  config,
  registry,
  filePath,
  accountIdentity,
  selectedCaptureKinds,
}) {
  if (!isAbsolute(filePath)) throw new Error('Import file must use an absolute path');
  const document = JSON.parse(await readFile(filePath, 'utf8'));
  requireObject(document, 'import document');
  if (document.schema !== 'social-memory.capture-export' || document.version !== 1) {
    throw new Error('Unsupported import schema or version');
  }
  if (!Array.isArray(document.captures) || document.captures.length === 0) {
    throw new Error('Import document must contain captures');
  }

  const importRoot = dirname(filePath);
  const prepared = [];
  for (const capture of document.captures) {
    prepared.push({
      kind: capture.kind,
      event: await normalizeImportedCapture(capture, importRoot, selectedCaptureKinds),
    });
  }

  const account = configureAccount(db, registry, {
    connectorId: 'import',
    identity: accountIdentity,
    selectedCaptureKinds,
  });
  const totals = {
    insertedSources: 0,
    insertedCaptures: 0,
    updatedCaptures: 0,
    insertedEvidence: 0,
    storedObjects: 0,
  };
  for (const kind of CAPTURE_KINDS) {
    const events = prepared.filter((item) => item.kind === kind).map((item) => item.event);
    if (events.length === 0) continue;
    const result = await ingestCaptureBatch(db, config, account, kind, events);
    for (const key of Object.keys(totals)) totals[key] += result[key];
  }

  return {
    status: 'imported',
    accountId: account.id,
    sources: totals.insertedSources,
    captures: totals.insertedCaptures + totals.updatedCaptures,
    ...totals,
  };
}
