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
const allowedRoots = ['src/', 'skills/', 'examples/', 'schemas/', 'assets/readme/'];
const allowedFiles = new Set(['package.json', 'README.md', 'README.ko.md', 'CHANGELOG.md', 'SECURITY.md']);
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
const agentDir = join(workDir, 'agent setup');
const agent = JSON.parse(run(executable, [
  'agent', 'scaffold', '--client', 'codex', '--output', agentDir, '--json',
], { env }).stdout);
if (agent.status !== 'created' || agent.client !== 'codex') {
  throw new Error('Installed CLI did not create a Codex agent scaffold');
}
const [generatedSkill, generatedMcpConfig] = await Promise.all([
  readFile(join(agentDir, 'skills', 'social-memory', 'SKILL.md'), 'utf8'),
  readFile(join(agentDir, 'mcp.toml'), 'utf8'),
]);
if (!generatedSkill.startsWith('---\nname: social-memory\n')) {
  throw new Error('Installed agent scaffold did not include the Social Memory Skill');
}
if (!generatedMcpConfig.includes(dataDir) || !generatedMcpConfig.includes('social-memory')) {
  throw new Error('Installed agent scaffold did not resolve its MCP paths');
}

const mcpInput = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
].map((request) => JSON.stringify(request)).join('\n') + '\n';
const mcpRun = run(executable, ['mcp'], { env, input: mcpInput });
if (mcpRun.stderr !== '') throw new Error(`Installed MCP emitted stderr: ${mcpRun.stderr.trim()}`);
const mcpResponses = mcpRun.stdout.trim().split('\n').map((line) => JSON.parse(line));
const mcpTools = mcpResponses
  .find(({ id }) => id === 2)
  ?.result?.tools?.map(({ name }) => name);
if (!Array.isArray(mcpTools)) throw new Error('Installed MCP did not return its tool list');

const digest = createHash('sha256').update(await readFile(tarball)).digest('hex');
process.stdout.write(`${JSON.stringify({
  status: 'ready',
  package: packed.filename,
  sha256: digest,
  files: files.length,
  installedVersion: version.stdout.trim(),
  license: packageManifest.license,
  agentScaffold: agent.client,
  mcpTools,
}, null, 2)}\n`);
