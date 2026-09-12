import assert from 'node:assert/strict';
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
