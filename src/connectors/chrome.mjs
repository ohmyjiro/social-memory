import { chmod, mkdir, lstat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

function browserError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireProfileRef(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error('Chrome profile reference must use only letters, numbers, dot, underscore, or hyphen');
  }
  return value;
}

function resolveProfileRoot(profileRoot, env) {
  if (profileRoot) {
    if (!isAbsolute(profileRoot)) throw new Error('Chrome profile root must be absolute');
    return profileRoot;
  }
  const dataDir = env.SOCIAL_MEMORY_DATA_DIR;
  if (!dataDir || !isAbsolute(dataDir)) {
    throw new Error('SOCIAL_MEMORY_DATA_DIR must be set before using Chrome profiles');
  }
  return join(dataDir, 'chrome-profiles');
}

async function privateDirectory(path) {
  const info = await lstat(path).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (info && (info.isSymbolicLink() || !info.isDirectory())) {
    throw browserError('unsafe_profile', 'Chrome profile directory cannot be a symlink or file');
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function launchSystemChrome(profilePath, options) {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch {
    throw browserError('browser_unavailable', 'playwright-core is required for Chrome connectors');
  }
  try {
    return await chromium.launchPersistentContext(profilePath, options);
  } catch (error) {
    throw browserError('browser_unavailable', `Google Chrome could not be started: ${error.message}`);
  }
}

export function createChromeSession({
  profileRoot,
  env = process.env,
  headless = true,
  launchPersistentContext = launchSystemChrome,
} = {}) {
  return Object.freeze({
    async withPage(profileRef, operation) {
      const root = resolveProfileRoot(profileRoot, env);
      const profilePath = join(root, requireProfileRef(profileRef));
      await privateDirectory(root);
      await privateDirectory(profilePath);
      const context = await launchPersistentContext(profilePath, { channel: 'chrome', headless });
      try {
        const page = context.pages()[0] ?? await context.newPage();
        return await operation(page, context);
      } finally {
        await context.close().catch(() => {});
      }
    },
  });
}

export function readThreadsIdentityDocument() {
  const profileNames = new Set(['프로필', 'Profile']);
  const link = [...document.querySelectorAll('a[href^="/@"]')].find((candidate) => {
    const name = candidate.getAttribute('aria-label') || candidate.querySelector('svg title')?.textContent || candidate.textContent || '';
    return profileNames.has(name.trim());
  });
  const href = link?.getAttribute('href');
  const handle = href?.match(/^\/@([^/?#]+)/)?.[1] ?? null;
  return {
    handle,
    profileUrl: href ? new URL(href, location.origin).href : null,
  };
}

export function readThreadsPostsDocument() {
  const authenticated = [...document.querySelectorAll('a[href^="/@"]')].some(link =>
    ['프로필', 'Profile'].includes((link.getAttribute('aria-label') || link.querySelector('svg title')?.textContent || link.textContent || '').trim()));
  const empty = [...document.querySelectorAll('[role="status"]')].some(node =>
    /^(저장한 게시물이 여기에 표시됩니다|saved posts will appear here)[.!]?$/i.test(node.textContent.trim()));
  const items = [];
  const seen = new Set();
  for (const link of document.querySelectorAll('a[href*="/post/"]')) {
    const sourceUrl = new URL(link.getAttribute('href'), location.origin).href;
    const match = sourceUrl.match(/threads\.com\/@([^/]+)\/post\/([^/?#]+)/);
    if (!match || seen.has(match[2])) continue;
    seen.add(match[2]);
    const container = link.closest('[role="article"], article');
    if (!container) continue;
    const time = container?.querySelector('time');
    const assets = [...(container?.querySelectorAll('img,video') ?? [])].map((asset) => ({
      kind: asset.tagName === 'VIDEO' ? 'video' : 'image',
      sourceUrl: asset.currentSrc || asset.src || sourceUrl,
      altText: asset.getAttribute('alt'),
    }));
    items.push({
      postId: match[2],
      sourceUrl,
      authorHandle: match[1],
      authorName: null,
      text: container?.innerText?.trim() ?? '',
      postedAt: time?.getAttribute('datetime') ?? null,
      assets,
    });
  }
  return { authenticated, empty, items };
}

export function readXIdentityDocument() {
  const link = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
  const href = link?.getAttribute('href');
  return {
    handle: href?.match(/^\/([^/?#]+)/)?.[1] ?? null,
    name: link?.getAttribute('aria-label') ?? null,
  };
}

export function readXPostsDocument() {
  const authenticated = Boolean(document.querySelector('[data-testid="AppTabBar_Profile_Link"]'));
  const empty = Boolean(document.querySelector('[data-testid="emptyState"]'));
  const items = [];
  const seen = new Set();
  for (const tweet of document.querySelectorAll('[data-testid="tweet"]')) {
    const link = [...tweet.querySelectorAll('a[href*="/status/"]')].find((candidate) =>
      /\/status\/[^/?#]+/.test(candidate.getAttribute('href') ?? ''));
    const sourceUrl = link ? new URL(link.getAttribute('href'), location.origin).href : null;
    const match = sourceUrl?.match(/x\.com\/([^/]+)\/status\/([^/?#]+)/);
    if (!match || seen.has(match[2])) continue;
    seen.add(match[2]);
    const time = tweet.querySelector('time');
    const assets = [...tweet.querySelectorAll('[data-testid="tweetPhoto"] img, video')].map((asset) => ({
      kind: asset.tagName === 'VIDEO' ? 'video' : 'image',
      sourceUrl: asset.currentSrc || asset.src || sourceUrl,
      altText: asset.getAttribute('alt'),
    }));
    items.push({
      postId: match[2],
      sourceUrl,
      authorHandle: match[1],
      authorName: null,
      text: tweet.querySelector('[data-testid="tweetText"]')?.innerText?.trim() ?? '',
      postedAt: time?.getAttribute('datetime') ?? null,
      assets,
    });
  }
  return { authenticated, empty, items };
}

function requireRoute(page, target) {
  const actual = new URL(page.url());
  const expected = new URL(target);
  if (actual.origin !== expected.origin || actual.pathname.replace(/\/$/, '') !== expected.pathname.replace(/\/$/, '')) {
    throw browserError('connector_drift', 'Collection page redirected away from the requested surface');
  }
}

async function waitIdentity(page, extractor) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const identity = await page.evaluate(extractor);
    if (identity?.handle) return identity;
    await page.waitForTimeout(500);
  }
  throw browserError('reauth_required', 'Authenticated profile was not found within 10 seconds');
}

async function requireCollectionIdentity(page, extractor, handle) {
  if (!handle) throw browserError('verification_required', 'Collection requires a verified account');
  const identity = await waitIdentity(page, extractor);
  if (identity.handle.toLowerCase() !== handle.replace(/^@/, '').toLowerCase()) {
    throw browserError('account_mismatch', 'Chrome account changed since verification');
  }
}

export function readSurfaceDocument(surface) {
  const names = {bookmarks:['Bookmarks','북마크'],saved:['Saved','저장됨'],likes:['Likes','Liked','좋아요'],reposts:['Reposts','리포스트']}[surface] ?? [];
  return [...document.querySelectorAll('h1,h2,[role="heading"],[role="tab"][aria-selected="true"],a[aria-current="page"]')]
    .some(node => node.getClientRects().length > 0 && names.includes(node.textContent.trim()));
}

async function waitSurface(page, surface) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await page.evaluate(readSurfaceDocument, surface)) return;
    await page.waitForTimeout(500);
  }
  throw browserError('connector_drift', 'Requested collection heading or selected tab was not found');
}

export async function collectVisiblePosts(page, extractor, limit, cursor, validate = async () => {}) {
  let anchor = null;
  if (cursor) {
    try { const state = JSON.parse(cursor); if (state.version !== 1 || typeof state.after !== 'string') throw Error(); anchor = state.after; }
    catch { throw browserError('invalid_cursor', 'Chrome cursor is invalid'); }
  }
  const items = new Map();
  const seen = new Set();
  let idle = 0;
  let resumed = !anchor;
  let snapshot = { authenticated: false, empty: false, items: [] };
  // ponytail: bounded UI scan; explicit failure preserves progress when an archive exceeds this budget.
  for (let round = 0; round < 120; round += 1) {
    await validate();
    snapshot = await page.evaluate(extractor);
    if (!snapshot.authenticated) throw browserError('reauth_required', 'Collection lost its authenticated profile');
    const previous = seen.size;
    for (const item of snapshot.items ?? []) {
      if (seen.has(item.postId)) continue;
      seen.add(item.postId);
      if (!resumed) { if (item.postId === anchor) resumed = true; continue; }
      if (item.postId === anchor) continue;
      items.set(item.postId, item);
      if (items.size >= limit) return { ...snapshot, items: [...items.values()], cursor: JSON.stringify({version:1,after:item.postId}) };
    }
    idle = previous === seen.size ? idle + 1 : 0;
    if (snapshot.empty || idle >= 5) {
      if (!resumed) throw browserError('cursor_missing', 'Resume post was not found; cursor was preserved');
      if (!items.size && !anchor && !snapshot.empty) throw browserError('connector_drift', 'No post or explicit empty state was found');
      return { ...snapshot, items: [...items.values()], empty: items.size === 0, cursor: null };
    }
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(700);
  }
  throw browserError('scan_limit', 'Chrome scan budget exhausted; existing cursor was preserved');
}

export function createChromeThreadsBridge({ session = createChromeSession() } = {}) {
  return Object.freeze({
    inspectIdentity({ profileRef }) {
      return session.withPage(profileRef, async (page) => {
        await page.goto('https://www.threads.com/', { waitUntil: 'domcontentloaded' });
        return waitIdentity(page, readThreadsIdentityDocument);
      });
    },
    readSurface({ profileRef, surface, limit, handle, cursor }) {
      const routes = {
        likes: 'https://www.threads.com/liked/',
        saved: 'https://www.threads.com/saved/',
      };
      return session.withPage(profileRef, async (page) => {
        let target = routes[surface];
        if (surface === 'reposts') {
          await page.goto('https://www.threads.com/', { waitUntil: 'domcontentloaded' });
          const identity = await waitIdentity(page, readThreadsIdentityDocument);
          if (!identity.handle) return { items: [], cursor: null, landmarks: [] };
          target = `https://www.threads.com/@${identity.handle}/reposts`;
        }
        if (!target) throw browserError('invalid_surface', `Unknown Threads surface: ${surface}`);
        await page.goto(target, { waitUntil: 'domcontentloaded' });
        requireRoute(page, target);
        await requireCollectionIdentity(page, readThreadsIdentityDocument, handle);
        await waitSurface(page, surface);
        const result = await collectVisiblePosts(page, readThreadsPostsDocument, Math.max(1, Number(limit) || 100), cursor,
          async () => { requireRoute(page, target); await requireCollectionIdentity(page, readThreadsIdentityDocument, handle); await waitSurface(page, surface); });
        const surfaceLandmark = { likes: 'like_state', saved: 'saved_surface', reposts: 'reposts_tab' }[surface];
        const landmarks = result.authenticated ? [surfaceLandmark] : [];
        if (result.items.length) landmarks.push('post_permalink');
        else if (result.empty) landmarks.push('empty_state');
        return { items: result.items, cursor: result.cursor, landmarks };
      });
    },
  });
}

export function createChromeXBridge({ session = createChromeSession() } = {}) {
  return Object.freeze({
    inspectIdentity({ profileRef }) {
      return session.withPage(profileRef, async (page) => {
        await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });
        return waitIdentity(page, readXIdentityDocument);
      });
    },
    readSurface({ profileRef, surface, handle, limit, cursor }) {
      const routes = {
        bookmarks: 'https://x.com/i/bookmarks',
        likes: `https://x.com/${handle}/likes`,
        reposts: `https://x.com/${handle}/reposts`,
      };
      const target = routes[surface];
      if (!target) throw browserError('invalid_surface', `Unknown X surface: ${surface}`);
      return session.withPage(profileRef, async (page) => {
        await page.goto(target, { waitUntil: 'domcontentloaded' });
        requireRoute(page, target);
        await requireCollectionIdentity(page, readXIdentityDocument, handle);
        await waitSurface(page, surface);
        const result = await collectVisiblePosts(page, readXPostsDocument, Math.max(1, Number(limit) || 100), cursor,
          async () => { requireRoute(page, target); await requireCollectionIdentity(page, readXIdentityDocument, handle); await waitSurface(page, surface); });
        const surfaceLandmark = surface === 'bookmarks' ? 'bookmarks_state' : `${surface}_state`;
        const landmarks = result.authenticated ? [surfaceLandmark] : [];
        if (result.items.length) landmarks.push('post_permalink');
        else if (result.empty) landmarks.push('empty_state');
        return { items: result.items, cursor: result.cursor, landmarks };
      });
    },
  });
}

export async function openChromeProfile({ profileRoot, profileRef, url }) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Chrome login URL must be an absolute http or https URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Chrome login URL must be an absolute http or https URL');
  }
  await mkdir(profileRoot, { recursive: true, mode: 0o700 });
  const session = createChromeSession({ profileRoot, headless: false });
  return session.withPage(profileRef, async (page, context) => {
    await page.goto(parsed.href, { waitUntil: 'domcontentloaded' });
    await new Promise((resolve) => context.once('close', resolve));
    return { status: 'closed', profileRef };
  });
}
