import { connectAccount, listAccounts } from './accounts.mjs';
import { ingestCaptureBatch } from './ingest.mjs';
import { normalizedIdentity } from './platform.mjs';

const INSTALLATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLATFORMS = new Set(['x', 'threads']);

function requireInstallationId(value) {
  if (typeof value !== 'string' || !INSTALLATION_ID.test(value)) {
    throw new Error('installationId must be a version 4 UUID');
  }
  return value.toLowerCase();
}

function requirePlatform(value) {
  if (!PLATFORMS.has(value)) throw new Error(`Unsupported extension platform: ${value}`);
  return value;
}

function requireIdentity(platform, value) {
  const identity = normalizedIdentity(platform, value);
  const pattern = platform === 'x' ? /^[a-z0-9_]{1,15}$/ : /^[a-z0-9._]{1,64}$/;
  if (!pattern.test(identity)) throw new Error(`Invalid ${platform} authenticated identity`);
  return identity;
}

function normalizeConnectorConfig(value) {
  if (!value || Object.keys(value).length !== 1 || typeof value.authenticatedIdentity !== 'string') {
    throw new Error('Extension connector requires one authenticated identity');
  }
  return {};
}

function extensionConnector(platform) {
  return Object.freeze({
    id: `${platform}-extension`,
    platform,
    capabilities: ['like', 'save', 'repost'],
    normalizeConfig: normalizeConnectorConfig,
    async verify({ account }) {
      return { status: 'ready', authenticatedIdentity: account.connectorConfig.authenticatedIdentity };
    },
  });
}

export const extensionConnectors = Object.freeze([
  extensionConnector('x'),
  extensionConnector('threads'),
]);

export function getExtensionConnection(db, installationId, platform) {
  const row = db.prepare(`
    SELECT account_id, installation_id, platform, created_at, updated_at, last_collected_at
    FROM extension_connections
    WHERE installation_id = ? AND platform = ?
  `).get(requireInstallationId(installationId), requirePlatform(platform));
  if (!row) return null;
  const account = listAccounts(db).find(({ id }) => id === row.account_id);
  return {
    installationId: row.installation_id,
    platform: row.platform,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastCollectedAt: row.last_collected_at,
    account,
  };
}

export async function connectExtension(db, registry, input) {
  const installationId = requireInstallationId(input?.installationId);
  const platform = requirePlatform(input?.platform);
  const authenticatedIdentity = requireIdentity(platform, input?.authenticatedIdentity);
  const account = await connectAccount(db, registry, {
    connectorId: `${platform}-extension`,
    selectedCaptureKinds: input.selectedCaptureKinds,
    connectorConfig: { authenticatedIdentity },
  });
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO extension_connections (
      installation_id, platform, account_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(installation_id, platform) DO UPDATE SET
      account_id = excluded.account_id,
      updated_at = excluded.updated_at
  `).run(installationId, platform, account.id, now, now);
  return { connection: getExtensionConnection(db, installationId, platform), account };
}

function canonicalPostUrl(platform, value, postId) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('sourceUrl must be a valid URL');
  }
  if (url.protocol !== 'https:') throw new Error('sourceUrl must use https');
  const segments = url.pathname.split('/').filter(Boolean);
  const valid = platform === 'x'
    ? ['x.com', 'twitter.com'].includes(url.hostname) && segments[1] === 'status' && segments[2] === postId
    : ['threads.com', 'www.threads.com'].includes(url.hostname) && segments[0]?.startsWith('@') && segments[1] === 'post' && segments[2] === postId;
  if (!valid) throw new Error(`sourceUrl is not a canonical ${platform} post URL`);
  return url.href;
}

function captureEvent(platform, kind, item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Extension item must be an object');
  if (typeof item.postId !== 'string' || item.postId.trim().length === 0) throw new Error('postId must be a non-empty string');
  const postId = item.postId.trim();
  const sourceUrl = canonicalPostUrl(platform, item.sourceUrl, postId);
  return {
    externalId: postId,
    canonicalUrl: sourceUrl,
    author: { handle: item.authorHandle, name: item.authorName },
    text: item.text,
    sourceCreatedAt: item.postedAt,
    capture: { kind, nativeKind: kind, capturedAt: null },
    evidence: item.text ? [{
      kind: 'text',
      text: item.text,
      sourceUrl,
      provenance: 'chrome-extension-dom',
    }] : [],
    raw: { transport: 'chrome-extension' },
  };
}

export async function ingestExtensionBatch(db, config, input) {
  const installationId = requireInstallationId(input?.installationId);
  const platform = requirePlatform(input?.platform);
  const authenticatedIdentity = requireIdentity(platform, input?.authenticatedIdentity);
  const connection = getExtensionConnection(db, installationId, platform);
  if (!connection) throw new Error('Extension profile is not connected');
  if (connection.account.authenticatedIdentity !== authenticatedIdentity) {
    const error = new Error('Authenticated account changed; reconnect this Chrome profile');
    error.code = 'account_mismatch';
    throw error;
  }
  if (!connection.account.selectedCaptureKinds.includes(input.kind)) {
    throw new Error(`Capture kind ${input.kind} is not selected for this Chrome profile`);
  }
  if (!Array.isArray(input.items)) throw new Error('items must be an array');
  const events = input.items.map((item) => captureEvent(platform, input.kind, item));
  const result = await ingestCaptureBatch(db, config, connection.account, input.kind, events);
  db.prepare(`
    UPDATE extension_connections SET last_collected_at = ?, updated_at = ?
    WHERE installation_id = ? AND platform = ?
  `).run(new Date().toISOString(), new Date().toISOString(), installationId, platform);
  return result;
}
