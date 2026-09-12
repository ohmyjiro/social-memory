import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

const API_ROOT = 'https://api.x.com/2';
const execFile = promisify(execFileCallback);

function connectorError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createEnvironmentCredentialProvider(env = process.env) {
  return async (account) => {
    const variable = account.connectorConfig?.credentialEnv ?? 'SOCIAL_MEMORY_X_ACCESS_TOKEN';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
      throw connectorError('invalid_config', 'X credential environment variable name is invalid');
    }
    const token = env[variable];
    if (!token) throw connectorError('reauth_required', `X credential is unavailable in ${variable}`);
    return token;
  };
}

export function createKeychainCredentialProvider({ execFileImpl = execFile } = {}) {
  return async (account) => {
    const service = account.connectorConfig?.keychainService;
    const keychainAccount = account.connectorConfig?.keychainAccount;
    if (!service || !keychainAccount) {
      throw connectorError('invalid_config', 'X Keychain service and account references are required');
    }
    try {
      const { stdout = '' } = await execFileImpl(
        'security',
        ['find-generic-password', '-w', '-s', service, '-a', keychainAccount],
        { shell: false, timeout: 10_000 },
      );
      const token = String(stdout).trim();
      if (!token) throw new Error('empty credential');
      return token;
    } catch {
      throw connectorError('reauth_required', 'X credential is unavailable in macOS Keychain');
    }
  };
}

export function createXCredentialProvider({
  env = process.env,
  execFileImpl = execFile,
} = {}) {
  const environmentProvider = createEnvironmentCredentialProvider(env);
  const keychainProvider = createKeychainCredentialProvider({ execFileImpl });
  return (account) => account.connectorConfig?.keychainService
    ? keychainProvider(account)
    : environmentProvider(account);
}

async function requestJson(fetchImpl, credentialProvider, account, url) {
  const token = await credentialProvider(account);
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
    },
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw connectorError('reauth_required', 'X authorization was rejected');
    }
    if (response.status === 429) throw connectorError('rate_limited', 'X rate limit reached');
    throw connectorError('connector_error', `X API request failed with status ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw connectorError('connector_drift', 'X API returned invalid JSON');
  }
}

function authorMap(payload) {
  return new Map((payload.includes?.users ?? []).map((user) => [user.id, user]));
}

function mediaMap(payload) {
  return new Map((payload.includes?.media ?? []).map((media) => [media.media_key, media]));
}

function originalRepost(tweet, payload) {
  const reference = tweet.referenced_tweets?.find(({ type }) => type === 'retweeted');
  if (!reference) return null;
  return (payload.includes?.tweets ?? []).find(({ id }) => id === reference.id) ?? null;
}

function mapTweet(tweet, kind, payload) {
  const sourceTweet = kind === 'repost' ? originalRepost(tweet, payload) : tweet;
  if (!sourceTweet) return null;
  const authors = authorMap(payload);
  const media = mediaMap(payload);
  const author = authors.get(sourceTweet.author_id);
  const evidence = [];
  for (const key of sourceTweet.attachments?.media_keys ?? []) {
    const item = media.get(key);
    if (!item) continue;
    if (item.alt_text) {
      evidence.push({ kind: 'text', text: item.alt_text, provenance: 'x-media-alt-text' });
    }
    const sourceUrl = item.url ?? item.preview_image_url;
    if (sourceUrl) {
      evidence.push({
        kind: 'text',
        text: `${item.type ?? 'media'}: ${sourceUrl}`,
        sourceUrl,
        provenance: 'x-media-metadata',
      });
    }
  }
  const canonicalUrl = author?.username
    ? `https://x.com/${author.username}/status/${sourceTweet.id}`
    : `https://x.com/i/web/status/${sourceTweet.id}`;
  const nativeKinds = { like: 'favorite', save: 'bookmark', repost: 'repost' };
  return {
    externalId: sourceTweet.id,
    canonicalUrl,
    author: { handle: author?.username ?? null, name: author?.name ?? null },
    text: sourceTweet.text ?? null,
    sourceCreatedAt: sourceTweet.created_at ?? null,
    capture: { kind, nativeKind: nativeKinds[kind], capturedAt: null },
    evidence,
    raw: { tweet: sourceTweet },
  };
}

function collectionUrl(userId, kind, cursor, limit) {
  const paths = {
    like: `/users/${userId}/liked_tweets`,
    save: `/users/${userId}/bookmarks`,
    repost: `/users/${userId}/tweets`,
  };
  const url = new URL(`${API_ROOT}${paths[kind]}`);
  url.searchParams.set('max_results', String(Math.max(5, Math.min(Number(limit) || 100, 100))));
  url.searchParams.set('tweet.fields', 'created_at,author_id,attachments,entities,referenced_tweets');
  url.searchParams.set('expansions', 'author_id,attachments.media_keys,referenced_tweets.id,referenced_tweets.id.author_id');
  url.searchParams.set('user.fields', 'username,name');
  url.searchParams.set('media.fields', 'media_key,type,url,preview_image_url,alt_text');
  if (cursor) url.searchParams.set('pagination_token', cursor);
  return url;
}

export function createXConnector({
  fetchImpl = globalThis.fetch,
  credentialProvider = createXCredentialProvider(),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('X connector requires fetch');
  return {
    id: 'x',
    capabilities: Object.freeze(['like', 'save', 'repost']),
    normalizeConfig(value) {
      const keys = Object.keys(value);
      const allowed = new Set(['credentialEnv', 'keychainService', 'keychainAccount']);
      if (keys.some((key) => !allowed.has(key))) {
        throw new Error(`Unknown X connector config field: ${keys.find((key) => !allowed.has(key))}`);
      }
      const hasEnvironment = value.credentialEnv !== undefined;
      const hasKeychain = value.keychainService !== undefined || value.keychainAccount !== undefined;
      if (hasEnvironment && hasKeychain) {
        throw new Error('X connector must use either environment or Keychain credential references');
      }
      if (hasKeychain) {
        if (
          typeof value.keychainService !== 'string' ||
          typeof value.keychainAccount !== 'string' ||
          !/^[A-Za-z0-9._@:-]+$/.test(value.keychainService) ||
          !/^[A-Za-z0-9._@:-]+$/.test(value.keychainAccount)
        ) {
          throw new Error('X Keychain service and account references are invalid');
        }
        return {
          keychainService: value.keychainService,
          keychainAccount: value.keychainAccount,
        };
      }
      const credentialEnv = value.credentialEnv ?? 'SOCIAL_MEMORY_X_ACCESS_TOKEN';
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(credentialEnv)) {
        throw new Error('X credential environment variable name is invalid');
      }
      return { credentialEnv };
    },
    async verify({ account }) {
      const url = new URL(`${API_ROOT}/users/me`);
      url.searchParams.set('user.fields', 'username,name');
      const payload = await requestJson(fetchImpl, credentialProvider, account, url);
      if (!payload.data?.id || !payload.data?.username) {
        throw connectorError('connector_drift', 'X identity response is missing required fields');
      }
      return {
        status: 'ready',
        configuredIdentity: account.configuredIdentity,
        authenticatedIdentity: payload.data.username,
        connectorState: { userId: payload.data.id },
      };
    },
    async collect({ account, kind, cursor, limit, verification }) {
      const userId = verification?.connectorState?.userId;
      if (!userId) throw connectorError('verification_required', 'X identity must be verified first');
      const payload = await requestJson(
        fetchImpl,
        credentialProvider,
        account,
        collectionUrl(userId, kind, cursor, limit),
      );
      if (payload.data !== undefined && !Array.isArray(payload.data)) {
        throw connectorError('connector_drift', 'X collection response has invalid data');
      }
      const events = (payload.data ?? [])
        .map((tweet) => mapTweet(tweet, kind, payload))
        .filter(Boolean);
      return { events, nextCursor: payload.meta?.next_token ?? null };
    },
  };
}

export const xConnector = Object.freeze(createXConnector());
