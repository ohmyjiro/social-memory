import assert from 'node:assert/strict';
import test from 'node:test';

import * as extensionReaders from '../extension/document-readers.js';
import * as chromeConnector from '../src/connectors/chrome.mjs';

test('Playwright and the extension share the same self-contained document readers', () => {
  for (const name of [
    'readThreadsIdentityDocument',
    'readThreadsPostsDocument',
    'readXIdentityDocument',
    'readXPostsDocument',
    'readSurfaceDocument',
  ]) {
    assert.equal(typeof extensionReaders[name], 'function');
    assert.equal(chromeConnector[name], extensionReaders[name]);
  }
});
