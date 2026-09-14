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
    const time = container.querySelector('time');
    const assets = [...container.querySelectorAll('img,video')].map((asset) => ({
      kind: asset.tagName === 'VIDEO' ? 'video' : 'image',
      sourceUrl: asset.currentSrc || asset.src || sourceUrl,
      altText: asset.getAttribute('alt'),
    }));
    items.push({
      postId: match[2],
      sourceUrl,
      authorHandle: match[1],
      authorName: null,
      text: container.innerText?.trim() ?? '',
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

export function readSurfaceDocument(surface) {
  const names = {bookmarks:['Bookmarks','북마크'],saved:['Saved','저장됨'],likes:['Likes','Liked','좋아요'],reposts:['Reposts','리포스트']}[surface] ?? [];
  return [...document.querySelectorAll('h1,h2,[role="heading"],[role="tab"][aria-selected="true"],a[aria-current="page"]')]
    .some(node => node.getClientRects().length > 0 && names.includes(node.textContent.trim()));
}
