import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { scaffoldAgentIntegration } from '../src/agent-scaffold.mjs';

test('agent scaffold generates a portable Codex skill and absolute MCP configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'social-memory-agent-'));
  const outputDir = join(root, 'Codex setup');
  const result = await scaffoldAgentIntegration({
    client: 'codex',
    outputDir,
    dataDir: '/Users/example/Social Memory Data',
    nodePath: '/opt/node/bin/node',
    cliPath: '/opt/social memory/src/cli.mjs',
  });

  const config = await readFile(join(outputDir, 'mcp.toml'), 'utf8');
  const skill = await readFile(join(outputDir, 'skills', 'social-memory', 'SKILL.md'), 'utf8');

  assert.equal(result.status, 'created');
  assert.match(config, /command = "\/opt\/node\/bin\/node"/);
  assert.match(config, /"\/opt\/social memory\/src\/cli\.mjs"/);
  assert.match(config, /SOCIAL_MEMORY_DATA_DIR = "\/Users\/example\/Social Memory Data"/);
  assert.match(skill, /^---\nname: social-memory\n/);
});

test('agent scaffold emits Claude-compatible JSON and refuses overwrite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'social-memory-agent-'));
  const outputDir = join(root, 'Claude setup');
  const input = {
    client: 'claude',
    outputDir,
    dataDir: '/Users/example/library',
    nodePath: '/opt/node',
    cliPath: '/opt/social-memory/cli.mjs',
  };
  await scaffoldAgentIntegration(input);
  const config = JSON.parse(await readFile(join(outputDir, '.mcp.json'), 'utf8'));

  assert.deepEqual(config.mcpServers['social-memory'], {
    command: '/opt/node',
    args: ['--disable-warning=ExperimentalWarning', '/opt/social-memory/cli.mjs', 'mcp'],
    env: { SOCIAL_MEMORY_DATA_DIR: '/Users/example/library' },
  });
  await assert.rejects(
    () => scaffoldAgentIntegration(input),
    (error) => error.code === 'agent_destination_exists',
  );
});
