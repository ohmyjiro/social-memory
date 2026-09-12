import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { exitCodeForResult, runCli, satisfiesNodeVersion } from '../src/cli.mjs';

function captureOutput() {
  let value = '';
  return {
    stream: { write(chunk) { value += String(chunk); } },
    read() { return value; },
  };
}

test('--help explains the deployable workflow without requiring a library', async () => {
  const output = captureOutput();
  const result = await runCli(['--help'], { env: {}, stdout: output.stream });

  assert.equal(result.status, 'help');
  assert.match(output.read(), /Usage: social-memory/);
  assert.match(output.read(), /doctor/);
  assert.match(output.read(), /--include like,save,repost/);
});

test('--version reads the package version without requiring a library', async () => {
  const output = captureOutput();
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  const result = await runCli(['--version'], { env: {}, stdout: output.stream });

  assert.deepEqual(result, { status: 'version', version: packageJson.version });
  assert.equal(output.read().trim(), packageJson.version);
});

test('doctor distinguishes an uninitialized path from a ready versioned library', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'social-memory-doctor-'));
  const dataDir = join(parent, 'not initialized');
  const env = { SOCIAL_MEMORY_DATA_DIR: dataDir };
  const output = captureOutput();

  const before = await runCli(['doctor', '--json'], { env, stdout: output.stream });
  assert.equal(before.status, 'needs_setup');
  assert.equal(before.checks.node.status, 'pass');
  assert.equal(before.checks.library.status, 'fail');

  await runCli(['init', '--data-dir', dataDir, '--json'], { env: {}, stdout: output.stream });
  const after = await runCli(['doctor', '--json'], { env, stdout: output.stream });
  assert.equal(after.status, 'ready');
  assert.equal(after.checks.schema.version, 2);
  assert.equal(after.checks.permissions.status, 'pass');
});

test('doctor reports a missing Aside CLI when a browser connector is configured', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'social-memory-doctor-aside-'));
  const dataDir = join(parent, 'library');
  const env = { SOCIAL_MEMORY_DATA_DIR: dataDir };
  const output = captureOutput();

  await runCli(['init', '--data-dir', dataDir, '--json'], { env: {}, stdout: output.stream });
  await runCli([
    'connector', 'configure', 'threads',
    '--account', 'reader_one',
    '--profile-ref', 'threads-reader',
    '--include', 'save',
    '--json',
  ], { env, stdout: output.stream });

  const result = await runCli(['doctor', '--json'], {
    env,
    stdout: output.stream,
    commandAvailable: () => false,
  });

  assert.equal(result.status, 'needs_attention');
  assert.deepEqual(result.checks.aside, {
    status: 'fail',
    reason: 'cli_not_found',
    requiredBy: ['threads'],
  });

  const available = await runCli(['doctor', '--json'], {
    env,
    stdout: output.stream,
    commandAvailable: () => true,
  });
  assert.equal(available.status, 'ready');
  assert.deepEqual(available.checks.aside, {
    status: 'pass',
    requiredBy: ['threads'],
  });
});

test('Node requirement checks the minor boundary instead of only the major version', () => {
  assert.equal(satisfiesNodeVersion('22.15.99', '22.16.0'), false);
  assert.equal(satisfiesNodeVersion('22.16.0', '22.16.0'), true);
  assert.equal(satisfiesNodeVersion('23.0.0', '22.16.0'), true);
});

test('failed and empty sync results produce a non-zero process exit code', () => {
  assert.equal(exitCodeForResult({ status: 'success' }), 0);
  assert.equal(exitCodeForResult({ status: 'partial' }), 2);
  assert.equal(exitCodeForResult({ status: 'failed' }), 2);
  assert.equal(exitCodeForResult({ status: 'no_streams' }), 2);
});

test('package manifest is publish-shaped and uses an explicit file allowlist', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));

  assert.notEqual(packageJson.private, true);
  assert.equal(packageJson.license, 'UNLICENSED');
  assert.deepEqual(packageJson.files, [
    'src/',
    'skills/',
    'templates/',
    'examples/',
    'schemas/',
    'README.md',
    'CHANGELOG.md',
    'SECURITY.md',
  ]);
  assert.equal(packageJson.publishConfig.access, 'public');
  assert.equal(packageJson.bin['social-memory'], './src/bin.mjs');
  assert.equal(packageJson.engines.node, '>=22.16');
  assert.deepEqual(packageJson.repository, {
    type: 'git',
    url: 'git+https://github.com/ohmyjiro/social-memory.git',
  });
  assert.equal(packageJson.homepage, 'https://github.com/ohmyjiro/social-memory#readme');
  assert.equal(packageJson.bugs.url, 'https://github.com/ohmyjiro/social-memory/issues');
  assert.equal(packageJson.scripts.prepublishOnly, 'npm run release:check');
});

test('public release check rejects an unlicensed package', () => {
  const result = spawnSync(process.execPath, ['scripts/release-check.mjs'], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /open-source license is selected/);
});

test('release artifact builder writes a portable checksum using only the tarball name', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'social-memory-release-artifacts-'));
  const result = spawnSync(process.execPath, ['scripts/build-release-artifacts.mjs', outputDir], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);

  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
  const filename = `${packageJson.name}-${packageJson.version}.tgz`;
  const tarball = await readFile(join(outputDir, filename));
  const digest = createHash('sha256').update(tarball).digest('hex');
  const checksum = await readFile(join(outputDir, 'SHA256SUMS'), 'utf8');

  assert.equal(checksum, `${digest}  ${filename}\n`);
});

test('release check exercises agent scaffolding and MCP from the installed tarball', () => {
  const result = spawnSync(process.execPath, [
    'scripts/release-check.mjs',
    '--allow-unlicensed',
  ], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);

  const report = JSON.parse(result.stdout);
  assert.equal(report.agentScaffold, 'codex');
  assert.deepEqual(report.mcpTools, [
    'search_sources',
    'get_source',
    'list_capture_kinds',
    'get_health',
  ]);
});
