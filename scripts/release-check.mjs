import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = new URL('../', import.meta.url);
const allowUnlicensed = process.argv.includes('--allow-unlicensed');
const packageManifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
if (!allowUnlicensed && (!packageManifest.license || packageManifest.license === 'UNLICENSED')) {
  throw new Error('Public release is blocked until an open-source license is selected');
}
const allowedRoots = ['src/', 'skills/', 'examples/', 'schemas/'];
const allowedFiles = new Set(['package.json', 'README.md', 'CHANGELOG.md', 'SECURITY.md']);
const forbiddenNames = [/.env(?:\.|$)/, /\.sqlite(?:-|$)/, /cookie/i, /session/i];
const forbiddenContents = [
  /\/Users\/[^/\s]+\//,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:password|access[_-]?token)\s*[:=]\s*["'][^<\s][^"']{7,}["']/i,
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result;
}

async function walk(root, prefix = '') {
  const paths = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) paths.push(...await walk(root, path));
    else if (entry.isFile()) paths.push(path);
  }
  return paths;
}

const workDir = await mkdtemp(join(tmpdir(), 'social-memory release check-'));
const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', workDir]).stdout)[0];
const tarball = join(workDir, packed.filename);
const extractDir = join(workDir, 'extracted');
await import('node:fs/promises').then(({ mkdir }) => mkdir(extractDir));
run('tar', ['-xzf', tarball, '-C', extractDir]);
const packageDir = join(extractDir, 'package');
const files = await walk(packageDir);

for (const path of files) {
  const normalized = path.replaceAll('\\', '/');
  if (!allowedFiles.has(normalized) && !allowedRoots.some((root) => normalized.startsWith(root))) {
    throw new Error(`Unexpected packaged file: ${normalized}`);
  }
  if (forbiddenNames.some((pattern) => pattern.test(normalized))) {
    throw new Error(`Forbidden packaged filename: ${normalized}`);
  }
  const content = await readFile(join(packageDir, path));
  const text = content.toString('utf8');
  if (forbiddenContents.some((pattern) => pattern.test(text))) {
    throw new Error(`Potential secret or private path in packaged file: ${normalized}`);
  }
}

const installRoot = join(workDir, 'installed prefix');
run('npm', ['install', '--prefix', installRoot, tarball]);
const executable = join(installRoot, 'node_modules', '.bin', 'social-memory');
await chmod(executable, 0o755);
const version = run(executable, ['--version']);
if (version.stderr !== '') throw new Error(`Installed CLI emitted stderr: ${version.stderr.trim()}`);
const dataDir = join(workDir, 'library with spaces');
run(executable, ['init', '--data-dir', dataDir, '--json']);
const env = { ...process.env, SOCIAL_MEMORY_DATA_DIR: dataDir };
run(executable, [
  'connector', 'configure', 'fixture', '--account', 'package_probe', '--include', 'like,save', '--json',
], { env });
const sync = JSON.parse(run(executable, ['sync', '--json'], { env }).stdout);
if (sync.status !== 'success' || sync.streams.length !== 2) {
  throw new Error('Installed fixture sync did not preserve two selected streams');
}
const digest = createHash('sha256').update(await readFile(tarball)).digest('hex');
process.stdout.write(`${JSON.stringify({
  status: 'ready',
  package: packed.filename,
  sha256: digest,
  files: files.length,
  installedVersion: version.stdout.trim(),
  license: packageManifest.license,
}, null, 2)}\n`);
