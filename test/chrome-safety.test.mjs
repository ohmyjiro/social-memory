import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createChromeSession, createChromeXBridge, collectVisiblePosts, readXPostsDocument, readThreadsPostsDocument } from '../src/connectors/chrome.mjs';
import { runCli } from '../src/cli.mjs';

test('dot paths and symlinks never launch a Chrome profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sm-safe-'));
  const profiles = join(root, 'profiles');
  await mkdir(profiles);
  await symlink(root, join(profiles, 'linked'));
  let launches = 0;
  const session = createChromeSession({ profileRoot: profiles, launchPersistentContext: async () => {
    launches++; return { pages: () => [{}], close: async () => {} };
  } });
  for (const name of ['.', '..', 'linked']) await assert.rejects(session.withPage(name, async () => {}));
  assert.equal(launches, 0);
});

test('CLI help does not require POSIX user IDs', async () => {
  const original = process.getuid;
  process.getuid = undefined;
  try { assert.equal((await runCli(['--help'], { env: {}, stdout: { write() {} } })).status, 'help'); }
  finally { process.getuid = original; }
});

test('redirected Chrome collection fails before post extraction', async () => {
  let extracted = false;
  const page = { goto: async () => {}, url: () => 'https://example.test/home',
    evaluate: async () => { extracted = true; return { authenticated: true, items: [{postId:'fictional'}] }; },
    waitForTimeout: async () => {} };
  const bridge = createChromeXBridge({ session: { withPage: async (_, fn) => fn(page) } });
  await assert.rejects(bridge.readSurface({profileRef:'fictional', surface:'bookmarks',handle:'reader',limit:1}), {code:'connector_drift'});
  assert.equal(extracted, false);
});

test('matching URL without the selected collection heading fails closed', async () => {
  const page = { goto:async()=>{},url:()=> 'https://x.com/i/bookmarks',waitForTimeout:async()=>{},
    evaluate:async fn => fn.name === 'readXIdentityDocument' ? {handle:'reader'} :
      fn.name === 'readXPostsDocument' ? {authenticated:true,empty:false,items:[{postId:'wrong'}]} : false };
  const bridge=createChromeXBridge({session:{withPage:async(_,fn)=>fn(page)}});
  await assert.rejects(bridge.readSurface({profileRef:'reader',surface:'bookmarks',handle:'reader',limit:1}),{code:'connector_drift'});
});

test('bounded collection resumes after the saved post and rejects a lost anchor', async () => {
  const extractor = () => {};
  const page = { evaluate: async fn => fn === extractor ? {authenticated:true,empty:false,items:[{postId:'a'},{postId:'b'},{postId:'c'}]} : null,
    waitForTimeout: async () => {} };
  const first = await collectVisiblePosts(page, extractor, 2, null);
  assert.deepEqual(first.items.map(item=>item.postId), ['a','b']);
  const next = await collectVisiblePosts(page, extractor, 2, first.cursor);
  assert.deepEqual(next.items.map(item=>item.postId), ['c']);
  assert.equal(next.cursor, null);
  await assert.rejects(collectVisiblePosts(page, extractor, 2, '{"version":1,"after":"gone"}'), {code:'cursor_missing'});
});

test('Chrome waits for delayed identity and blocks account changes before extracting posts', async () => {
  let attempts = 0;
  const page = {goto:async()=>{}, evaluate:async()=>({handle:++attempts < 3 ? null : 'reader'}),waitForTimeout:async()=>{}};
  const bridge = createChromeXBridge({session:{withPage:async(_,fn)=>fn(page)}});
  assert.equal((await bridge.inspectIdentity({profileRef:'fictional'})).handle,'reader');
  assert.equal(attempts,3);
  page.url=()=> 'https://x.com/i/bookmarks';
  await assert.rejects(bridge.readSurface({profileRef:'fictional',surface:'bookmarks',handle:'other',limit:1}),{code:'account_mismatch'});
});

test('real Chrome DOM extractors preserve posts mentioning login and ignore unbounded Threads markup',
  {skip:process.env.SOCIAL_MEMORY_CHROME_TEST !== '1'}, async t => {
    const {chromium} = await import('playwright-core');
    const browser = await chromium.launch({channel:'chrome',headless:true});
    t.after(()=>browser.close());
    const page = await browser.newPage();
    await page.route('**/*', route => route.fulfill({contentType:'text/html',body:'<html><body></body></html>'}));
    await page.goto('https://example.test/');
    await page.setContent('<a data-testid="AppTabBar_Profile_Link" href="/reader">Profile</a><article data-testid="tweet"><a href="https://x.com/fictional/status/123">date</a><div data-testid="tweetText">로그인 구현 방법</div><time datetime="2026-01-01T00:00:00Z"></time></article>');
    const x = await page.evaluate(readXPostsDocument);
    assert.equal(x.authenticated,true);
    assert.equal(x.items[0].text,'로그인 구현 방법');
    await page.setContent('<a href="/@reader"><svg><title>프로필</title></svg></a><article><a href="https://www.threads.com/@fictional/post/123">post</a><p>Log in 구현 방법</p></article><div><a href="https://www.threads.com/@fictional/post/unbounded">unbounded</a></div>');
    const threads = await page.evaluate(readThreadsPostsDocument);
    assert.equal(threads.authenticated,true);
    assert.deepEqual(threads.items.map(item=>item.postId),['123']);
    assert.match(threads.items[0].text,/Log in/);
  });
