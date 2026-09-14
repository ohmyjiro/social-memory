import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = new URL('../', import.meta.url);
const extensionRoot = new URL('../extension/', import.meta.url);
const requestedOutput = process.argv[2];
if (!requestedOutput) throw new Error('Output directory is required');

const outputDir = resolve(requestedOutput);
await mkdir(outputDir, { recursive: true });
if ((await readdir(outputDir)).length > 0) {
  throw new Error('Release artifact output directory must be empty');
}

const packedResult = spawnSync('npm', [
  'pack',
  '--json',
  '--pack-destination', outputDir,
], {
  cwd: projectRoot,
  encoding: 'utf8',
});
if (packedResult.status !== 0) {
  throw new Error(`npm pack failed: ${(packedResult.stderr || packedResult.stdout).trim()}`);
}

const [packed] = JSON.parse(packedResult.stdout);
const filename = packed?.filename;
if (!filename || basename(filename) !== filename || !filename.endsWith('.tgz')) {
  throw new Error('npm pack returned an unsafe artifact filename');
}

const tarballPath = join(outputDir, filename);
function digest(path) {
  return new Promise((resolveDigest, reject) => {
    const hash = createHash('sha256');
    const input = createReadStream(path);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolveDigest(hash.digest('hex')));
  });
}

async function extensionFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const path = new URL(relative, extensionRoot);
    const details = await lstat(path);
    if (details.isSymbolicLink()) throw new Error(`Extension artifact cannot include symlink: ${relative}`);
    if (entry.isDirectory()) files.push(...await extensionFiles(path, relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error(`Extension artifact contains unsupported entry: ${relative}`);
  }
  return files;
}

const extensionFilename = `social-memory-extension-${packed.version}.zip`;
const extensionZipPath = join(outputDir, extensionFilename);
const zipFiles = (await extensionFiles(extensionRoot)).sort();
if (!zipFiles.includes('manifest.json')) throw new Error('Extension manifest is missing');
const zipResult = spawnSync('zip', ['-q', extensionZipPath, ...zipFiles], {
  cwd: extensionRoot,
  encoding: 'utf8',
});
if (zipResult.status !== 0) throw new Error(`zip failed: ${(zipResult.stderr || zipResult.stdout).trim()}`);

const tarballDigest = await digest(tarballPath);
const extensionDigest = await digest(extensionZipPath);
await writeFile(join(outputDir, 'SHA256SUMS'), `${tarballDigest}  ${filename}\n${extensionDigest}  ${extensionFilename}\n`, {
  encoding: 'utf8',
  flag: 'wx',
  mode: 0o644,
});

process.stdout.write(`${JSON.stringify({
  status: 'ready',
  outputDir,
  filename,
  sha256: tarballDigest,
  extensionFilename,
  extensionSha256: extensionDigest,
}, null, 2)}\n`);
