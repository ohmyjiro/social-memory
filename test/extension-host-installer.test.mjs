import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { installExtensionHost } from '../src/extension-host-installer.mjs';

const extensionId = 'abcdefghijklmnopabcdefghijklmnop';

test('macOS host install creates private launcher and exact allowed origin', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'social-memory-host-home-'));
  const dataDir = join(homeDir, 'Social Memory Data');
  const hostScriptPath = join(homeDir, 'extension-host.mjs');
  const nodePath = join(homeDir, 'node');
  await writeFile(hostScriptPath, 'host');
  await writeFile(nodePath, 'node');

  const result = await installExtensionHost({
    platform: 'darwin', homeDir, extensionId, dataDir, nodePath, hostScriptPath,
  });
  const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
  assert.equal(manifest.name, 'com.ohmyjiro.social_memory');
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${extensionId}/`]);
  assert.equal(manifest.path, result.launcherPath);
  assert.equal((await stat(result.manifestPath)).mode & 0o777, 0o600);
  assert.equal((await stat(result.launcherPath)).mode & 0o777, 0o700);
  assert.match(await readFile(result.launcherPath, 'utf8'), /SOCIAL_MEMORY_DATA_DIR/);
});

test('installer rejects invalid IDs, Windows, and existing symlink targets before overwrite', async () => {
  const homeDir = await mkdtemp(join(tmpdir(), 'social-memory-host-unsafe-'));
  const input = {
    platform: 'darwin', homeDir, extensionId,
    dataDir: join(homeDir, 'data'), nodePath: join(homeDir, 'node'), hostScriptPath: join(homeDir, 'host.mjs'),
  };
  await assert.rejects(installExtensionHost({ ...input, extensionId: 'not-an-id' }), /extension id/i);
  await assert.rejects(installExtensionHost({ ...input, platform: 'win32' }), /unsupported/i);

  const manifestDir = join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts');
  const victim = join(homeDir, 'victim');
  await writeFile(victim, 'do not overwrite');
  await mkdir(manifestDir, { recursive: true });
  await symlink(victim, join(manifestDir, 'com.ohmyjiro.social_memory.json'));
  await assert.rejects(installExtensionHost(input), /symbolic link/i);
  assert.equal(await readFile(victim, 'utf8'), 'do not overwrite');
});
