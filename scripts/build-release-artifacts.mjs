import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = new URL('../', import.meta.url);
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
const digest = await new Promise((resolveDigest, reject) => {
  const hash = createHash('sha256');
  const input = createReadStream(tarballPath);
  input.on('error', reject);
  input.on('data', (chunk) => hash.update(chunk));
  input.on('end', () => resolveDigest(hash.digest('hex')));
});

await writeFile(join(outputDir, 'SHA256SUMS'), `${digest}  ${filename}\n`, {
  encoding: 'utf8',
  flag: 'wx',
  mode: 0o644,
});

process.stdout.write(`${JSON.stringify({
  status: 'ready',
  outputDir,
  filename,
  sha256: digest,
}, null, 2)}\n`);
