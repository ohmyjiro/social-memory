import { chmod, lstat, mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

const HOST_NAME = 'com.ohmyjiro.social_memory';
const EXTENSION_ID = /^[a-p]{32}$/;

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  return value;
}

async function rejectUnsafeFile(path, label) {
  const info = await lstat(path).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (info?.isSymbolicLink()) throw new Error(`${label} cannot be a symbolic link`);
  if (info && !info.isFile()) throw new Error(`${label} must be a regular file`);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function installExtensionHost({
  platform,
  homeDir,
  extensionId,
  dataDir,
  nodePath,
  hostScriptPath,
}) {
  if (platform === 'win32') {
    const error = new Error('Windows Native Messaging installation is unsupported in this release');
    error.code = 'unsupported_platform';
    throw error;
  }
  if (!['darwin', 'linux'].includes(platform)) throw new Error(`Unsupported platform: ${platform}`);
  if (typeof extensionId !== 'string' || !EXTENSION_ID.test(extensionId)) {
    throw new Error('Chrome extension id must be 32 lowercase letters from a to p');
  }
  requireAbsolute(homeDir, 'Home directory');
  requireAbsolute(dataDir, 'Data directory');
  requireAbsolute(nodePath, 'Node path');
  requireAbsolute(hostScriptPath, 'Host script path');

  const manifestDir = platform === 'darwin'
    ? join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts')
    : join(homeDir, '.config', 'google-chrome', 'NativeMessagingHosts');
  const launcherDir = join(homeDir, '.local', 'share', 'social-memory', 'native-host');
  const manifestPath = join(manifestDir, `${HOST_NAME}.json`);
  const launcherPath = join(launcherDir, HOST_NAME);
  await rejectUnsafeFile(manifestPath, 'Native host manifest');
  await rejectUnsafeFile(launcherPath, 'Native host launcher');
  await mkdir(manifestDir, { recursive: true, mode: 0o700 });
  await mkdir(launcherDir, { recursive: true, mode: 0o700 });
  await chmod(launcherDir, 0o700);

  const launcher = `#!/bin/sh\nexport SOCIAL_MEMORY_DATA_DIR=${shellQuote(dataDir)}\nexec ${shellQuote(nodePath)} ${shellQuote(hostScriptPath)}\n`;
  await writeFile(launcherPath, launcher, { mode: 0o700 });
  await chmod(launcherPath, 0o700);
  const manifest = {
    name: HOST_NAME,
    description: 'Social Memory local library bridge',
    path: launcherPath,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`],
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await chmod(manifestPath, 0o600);
  return { hostName: HOST_NAME, manifestPath, launcherPath };
}
