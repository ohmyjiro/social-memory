import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runCli } from '../src/cli.mjs';
import { loadConfig } from '../src/config.mjs';
import { openDatabase } from '../src/db.mjs';
import { handleMcpRequest } from '../src/mcp.mjs';

function captureOutput() {
  const lines = [];
  return {
    lines,
    write(value) { lines.push(String(value)); },
  };
}

test('CLI keeps fixture like and save separately searchable after reconfiguration', async (t) => {
  const dataDir = join(await mkdtemp(join(tmpdir(), 'social-memory-cli-')), 'private data');
  const env = { SOCIAL_MEMORY_DATA_DIR: dataDir };
  const output = captureOutput();

  await runCli(['init', '--data-dir', dataDir, '--json'], { env: {}, stdout: output });
  const configured = await runCli([
    'connector', 'configure', 'fixture',
    '--account', 'fictional_reader',
    '--include', 'save,like',
    '--json',
  ], { env, stdout: output });
  assert.deepEqual(configured.selectedCaptureKinds, ['like', 'save']);

  const sync = await runCli(['sync', '--json'], { env, stdout: output });
  assert.equal(sync.status, 'success');
  const liked = await runCli(['search', 'fixture', '--kind', 'like', '--json'], { env, stdout: output });
  const saved = await runCli(['search', 'fixture', '--kind', 'save', '--json'], { env, stdout: output });
  assert.equal(liked.length, 1);
  assert.equal(saved.length, 1);
  assert.equal(liked[0].id, saved[0].id);
  assert.deepEqual(liked[0].captureKinds, ['like', 'save']);

  await runCli([
    'connector', 'configure', 'fixture',
    '--account', 'fictional_reader',
    '--include', 'like',
    '--json',
  ], { env, stdout: output });
  const savedAfter = await runCli(['search', 'fixture', '--kind', 'save', '--json'], { env, stdout: output });
  assert.equal(savedAfter.length, 1);
});

test('MCP exposes only four read-only tools and serves structured retrieval', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'social-memory-mcp-'));
  const env = { SOCIAL_MEMORY_DATA_DIR: dataDir };
  const output = captureOutput();
  await runCli(['init', '--data-dir', dataDir, '--json'], { env: {}, stdout: output });
  await runCli([
    'connector', 'configure', 'fixture',
    '--account', 'fictional_reader',
    '--include', 'like,save',
    '--json',
  ], { env, stdout: output });
  await runCli(['sync', '--json'], { env, stdout: output });

  const config = loadConfig(env);
  const db = openDatabase(config.dbPath);
  t.after(() => db.close());
  const context = { db, config };

  const initialized = await handleMcpRequest({
    jsonrpc: '2.0', id: 1, method: 'initialize', params: {},
  }, context);
  assert.equal(initialized.result.serverInfo.name, 'social-memory');

  const listed = await handleMcpRequest({
    jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
  }, context);
  assert.deepEqual(listed.result.tools.map(({ name }) => name), [
    'search_sources',
    'get_source',
    'list_capture_kinds',
    'get_health',
  ]);
  assert.ok(listed.result.tools.every((tool) => tool.annotations.readOnlyHint === true));

  const called = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'search_sources', arguments: { query: 'fixture', kinds: ['save'] } },
  }, context);
  assert.equal(called.result.structuredContent.sources.length, 1);
  assert.equal(called.result.isError, false);

  const rejected = await handleMcpRequest({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'sync', arguments: {} },
  }, context);
  assert.equal(rejected.error.code, -32601);
});

test('CLI exposes backup, restore, scheduler, and agent scaffold workflows', async () => {
  const root = await mkdtemp(join(tmpdir(), 'social-memory-operations-'));
  const dataDir = join(root, 'source library');
  const restoredDir = join(root, 'restored library');
  const backupDir = join(root, 'backup bundle');
  const agentDir = join(root, 'agent setup');
  const env = { SOCIAL_MEMORY_DATA_DIR: dataDir };
  const output = captureOutput();
  await runCli(['init', '--data-dir', dataDir], { env: {}, stdout: output });
  await runCli([
    'connector', 'configure', 'fixture',
    '--account', 'fictional_reader',
    '--include', 'save',
  ], { env, stdout: output });
  await runCli(['sync'], { env, stdout: output });

  const installed = await runCli(['schedule', 'install', '--interval-minutes', '60'], {
    env,
    stdout: output,
    scheduleManager: {
      install: async ({ intervalMinutes }) => ({ status: 'installed', intervalMinutes }),
    },
  });
  const backup = await runCli(['backup', 'create', '--output', backupDir], { env, stdout: output });
  const restored = await runCli([
    'backup', 'restore', '--from', backupDir, '--data-dir', restoredDir,
  ], { env: {}, stdout: output });
  const agent = await runCli([
    'agent', 'scaffold', '--client', 'codex', '--output', agentDir,
  ], { env, stdout: output });

  assert.deepEqual(installed, { status: 'installed', intervalMinutes: 60 });
  assert.equal(backup.status, 'created');
  assert.equal(restored.status, 'restored');
  assert.equal(agent.status, 'created');
});
