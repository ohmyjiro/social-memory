import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import {
  createNativeMessageDecoder,
  encodeNativeMessage,
  handleExtensionRequest,
  runNativeHost,
} from '../src/extension-host.mjs';

test('native messages survive split framing and reject oversized input', () => {
  const decoder = createNativeMessageDecoder({ maxBytes: 1024 });
  const message = { version: 1, id: 'a', method: 'health', params: {} };
  const encoded = encodeNativeMessage(message);
  assert.deepEqual(decoder.push(encoded.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(encoded.subarray(3)), [message]);
  assert.throws(() => decoder.push(Buffer.from([255, 255, 255, 127])), /too large/i);
});

test('request dispatch has one stable response shape', async () => {
  const calls = [];
  const context = {
    connect: async (params) => { calls.push(['connect', params]); return { connected: true }; },
    status: (params) => { calls.push(['status', params]); return null; },
    ingest: async (params) => { calls.push(['ingest', params]); return { insertedSources: 1 }; },
  };
  assert.deepEqual(await handleExtensionRequest(context, {
    version: 1, id: 'h', method: 'health', params: {},
  }), { version: 1, id: 'h', ok: true, result: { status: 'ready', protocolVersion: 1 } });
  assert.equal((await handleExtensionRequest(context, {
    version: 1, id: 'c', method: 'connect', params: { platform: 'x' },
  })).ok, true);
  assert.equal((await handleExtensionRequest(context, {
    version: 1, id: 'bad', method: 'unknown', params: {},
  })).error.code, 'unknown_method');
  assert.equal((await handleExtensionRequest(context, {
    version: 1, id: 'bad-fields', method: 'health', params: {}, surprise: true,
  })).error.code, 'invalid_request');
  assert.deepEqual(calls, [['connect', { platform: 'x' }]]);
});

test('native host writes only framed JSON to stdout and diagnostics to stderr', async () => {
  const input = PassThrough.from([encodeNativeMessage({ version: 1, id: 'a', method: 'health', params: {} })]);
  const output = new PassThrough();
  const error = new PassThrough();
  const outputChunks = [];
  const errorChunks = [];
  output.on('data', (chunk) => outputChunks.push(chunk));
  error.on('data', (chunk) => errorChunks.push(chunk));

  await runNativeHost({
    input,
    output,
    error,
    createContext: async () => ({ connect() {}, status() {}, ingest() {} }),
  });

  const decoded = createNativeMessageDecoder({ maxBytes: 1024 }).push(Buffer.concat(outputChunks));
  assert.equal(decoded[0].ok, true);
  assert.doesNotMatch(Buffer.concat(outputChunks).toString('utf8'), /Social Memory native host/);
  assert.match(Buffer.concat(errorChunks).toString('utf8'), /native host/i);
});
