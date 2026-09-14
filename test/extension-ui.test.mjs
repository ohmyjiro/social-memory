import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('extension manifest uses the required least-privilege surface', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url)));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions.sort(), ['alarms', 'nativeMessaging', 'scripting', 'storage']);
  assert.deepEqual(manifest.host_permissions.sort(), [
    'https://*.threads.com/*',
    'https://threads.com/*',
    'https://twitter.com/*',
    'https://x.com/*',
  ].sort());
  assert.equal(manifest.background.service_worker, 'service-worker.js');
  assert.equal(manifest.background.type, 'module');
  assert.equal(manifest.incognito, 'not_allowed');
});

test('popup exposes labelled capture choices and connection actions', async () => {
  const html = await readFile(new URL('../extension/popup.html', import.meta.url), 'utf8');
  assert.match(html, /<label[^>]*>[^<]*<input[^>]+value="like"/s);
  assert.match(html, /<label[^>]*>[^<]*<input[^>]+value="save"/s);
  assert.match(html, /<label[^>]*>[^<]*<input[^>]+value="repost"/s);
  assert.match(html, /id="connect"/);
  assert.match(html, /id="collect-now"/);
  assert.match(html, /id="daily"/);
});
