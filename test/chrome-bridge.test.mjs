import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  createChromeSession,
  createChromeThreadsBridge,
  createChromeXBridge,
} from '../src/connectors/chrome.mjs';

test('Chrome session isolates every account in its own persistent profile directory', async () => {
  const launches = [];
  const page = { marker: 'page' };
  const profileRoot = await mkdtemp(join(tmpdir(), 'social-memory-chrome-profiles-'));
  const session = createChromeSession({
    profileRoot,
    launchPersistentContext: async (profilePath, options) => {
      launches.push({ profilePath, options });
      return {
        pages: () => [page],
        newPage: async () => { throw new Error('existing page should be reused'); },
        close: async () => {},
      };
    },
  });

  const result = await session.withPage('reader-one', async (candidate) => candidate.marker);

  assert.equal(result, 'page');
  assert.deepEqual(launches, [{
    profilePath: join(profileRoot, 'reader-one'),
    options: { channel: 'chrome', headless: true },
  }]);
  assert.equal((await stat(join(profileRoot, 'reader-one'))).mode & 0o777, 0o700);
  await assert.rejects(() => session.withPage('../shared', async () => {}), /profile reference/i);
});

test('Chrome Threads bridge returns the authenticated handle and saved post evidence', async () => {
  const visits = [];
  const identity = { handle: 'reader_one', profileUrl: 'https://www.threads.com/@reader_one' };
  const collection = {
      authenticated: true,
      empty: false,
      items: [{
        postId: 'thread-post-1',
        sourceUrl: 'https://www.threads.com/@writer/post/thread-post-1',
        authorHandle: 'writer',
        authorName: null,
        text: 'A saved product idea',
        postedAt: '2026-09-01T02:03:04.000Z',
        assets: [],
      }],
    };
  const page = {
    async goto(url) { visits.push(url); },
    url() { return visits.at(-1); },
    async evaluate(operation) {
      if (operation.name === 'readThreadsIdentityDocument') return identity;
      if (operation.name === 'readSurfaceDocument') return true;
      if (operation.name === 'readThreadsPostsDocument') return collection;
      return undefined;
    },
    async waitForTimeout() {},
  };
  const browserBridge = createChromeThreadsBridge({
    session: { withPage: async (_profileRef, operation) => operation(page) },
  });

  assert.deepEqual(await browserBridge.inspectIdentity({ profileRef: 'reader-one' }), {
    handle: 'reader_one',
    profileUrl: 'https://www.threads.com/@reader_one',
  });
  const result = await browserBridge.readSurface({
    profileRef: 'reader-one',
    surface: 'saved',
    handle: 'reader_one',
    limit: 3,
  });

  assert.deepEqual(visits, ['https://www.threads.com/', 'https://www.threads.com/saved/']);
  assert.equal(result.items[0].postId, 'thread-post-1');
  assert.deepEqual(result.landmarks, ['saved_surface', 'post_permalink']);
});

test('Chrome X bridge reads bookmarks through the page and never labels them as an API result', async () => {
  const visits = [];
  const identity = { handle: 'reader_one', name: 'Reader One' };
  const collection = {
      authenticated: true,
      empty: false,
      items: [{
        postId: 'x-post-1',
        sourceUrl: 'https://x.com/writer/status/x-post-1',
        authorHandle: 'writer',
        authorName: null,
        text: 'A bookmarked implementation note',
        postedAt: '2026-09-01T00:00:00.000Z',
        assets: [],
      }],
    };
  const page = {
    async goto(url) { visits.push(url); },
    url() { return visits.at(-1); },
    async evaluate(operation) {
      if (operation.name === 'readXIdentityDocument') return identity;
      if (operation.name === 'readSurfaceDocument') return true;
      if (operation.name === 'readXPostsDocument') return collection;
      return undefined;
    },
    async waitForTimeout() {},
  };
  const browserBridge = createChromeXBridge({
    session: { withPage: async (_profileRef, operation) => operation(page) },
  });

  assert.deepEqual(await browserBridge.inspectIdentity({ profileRef: 'reader-one' }), {
    handle: 'reader_one',
    name: 'Reader One',
  });
  const result = await browserBridge.readSurface({
    profileRef: 'reader-one',
    surface: 'bookmarks',
    handle: 'reader_one',
    limit: 3,
  });

  assert.deepEqual(visits, ['https://x.com/home', 'https://x.com/i/bookmarks']);
  assert.equal(result.items[0].postId, 'x-post-1');
  assert.deepEqual(result.landmarks, ['bookmarks_state', 'post_permalink']);
});
