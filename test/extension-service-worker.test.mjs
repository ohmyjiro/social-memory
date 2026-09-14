import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectPlatform,
  createController,
  detectPlatform,
  getInstallationId,
} from '../extension/service-worker.js';

function storage() {
  const values = {};
  return {
    values,
    async get(key) { return { [key]: values[key] }; },
    async set(input) { Object.assign(values, input); },
  };
}

test('each Chrome profile storage gets its own persistent installation id', async () => {
  const first = storage();
  const second = storage();
  const firstId = await getInstallationId(first);
  assert.equal(await getInstallationId(first), firstId);
  assert.notEqual(await getInstallationId(second), firstId);
  assert.match(firstId, /^[0-9a-f-]{36}$/);
});

test('platform detection is limited to X and Threads hosts', () => {
  assert.equal(detectPlatform({ url: 'https://x.com/home' }), 'x');
  assert.equal(detectPlatform({ url: 'https://www.threads.com/' }), 'threads');
  assert.equal(detectPlatform({ url: 'https://example.com/' }), null);
});

test('connect sends the DOM-detected handle without accepting a typed identity', async () => {
  const calls = [];
  const local = storage();
  const controller = createController({
    storage: local,
    activeTab: async () => ({ id: 7, url: 'https://x.com/home' }),
    readIdentity: async () => ({ handle: 'reader_one' }),
    request: async (method, params) => { calls.push({ method, params }); return { account: { configuredIdentity: 'reader_one' } }; },
    collect: async () => ({}),
    alarms: { async create() {}, async clear() {} },
  });
  const result = await controller.handle({ type: 'connect', selectedCaptureKinds: ['save'] });
  assert.equal(result.ok, true);
  assert.equal(calls[0].params.authenticatedIdentity, 'reader_one');
  assert.equal('identity' in calls[0].params, false);
});

test('account mismatch prevents ingest and extension closes only its own collection tab', async () => {
  const requests = [];
  const local = storage();
  await local.set({ 'social-memory:installation-id': '11111111-1111-4111-8111-111111111111' });
  const removed = [];
  const chromeApi = {
    storage: { local },
    tabs: {
      async create() { return { id: 99 }; },
      async get() { return { status: 'complete' }; },
      async remove(id) { removed.push(id); },
      onUpdated: { addListener() {}, removeListener() {} },
    },
    scripting: {
      async executeScript({ func }) {
        if (func.name === 'readXIdentityDocument') return [{ result: { handle: 'other_reader' } }];
        throw new Error('Collection must stop after identity mismatch');
      },
    },
  };
  await assert.rejects(
    collectPlatform('x', ['save'], 100, {
      chromeApi,
      expectedHandle: 'reader_one',
      request: async (...args) => requests.push(args),
    }),
    /account changed/i,
  );
  assert.deepEqual(requests, []);
  assert.deepEqual(removed, [99]);
});

test('startup recreates the daily alarm from persisted settings', async () => {
  const local = storage();
  await local.set({ 'social-memory:daily': true });
  const created = [];
  const controller = createController({
    storage: local,
    alarms: { async create(name, options) { created.push({ name, options }); }, async clear() {} },
  });
  await controller.ensureDailyAlarm();
  assert.equal(created[0].name, 'social-memory-daily');
  assert.equal(created[0].options.periodInMinutes, 1440);
});
