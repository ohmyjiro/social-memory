import { access, cp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function scaffoldError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireAbsolute(value, field) {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw scaffoldError('invalid_path', `${field} must be an absolute path`);
  }
  return resolve(value);
}

function commandDefinition({ nodePath, cliPath, dataDir }) {
  return {
    command: nodePath,
    args: ['--disable-warning=ExperimentalWarning', cliPath, 'mcp'],
    env: { SOCIAL_MEMORY_DATA_DIR: dataDir },
  };
}

function codexToml(definition) {
  return `[mcp_servers."social-memory"]
command = ${JSON.stringify(definition.command)}
args = ${JSON.stringify(definition.args)}

[mcp_servers."social-memory".env]
SOCIAL_MEMORY_DATA_DIR = ${JSON.stringify(definition.env.SOCIAL_MEMORY_DATA_DIR)}
`;
}

function installNotes(client) {
  const configName = client === 'codex' ? 'mcp.toml' : '.mcp.json';
  const clientRoot = client === 'codex' ? '~/.codex' : '~/.claude';
  return `# Social Memory agent integration

1. Copy \`skills/social-memory\` into \`${clientRoot}/skills/social-memory\`.
2. Merge \`${configName}\` into the client's MCP configuration. Do not overwrite unrelated servers.
3. Restart the client and confirm that \`get_health\` and \`search_sources\` are available.
4. Ask the client to search the library and distinguish retrieved Evidence from new synthesis.

The generated configuration contains absolute executable and data paths. It contains no access token, cookie, password, or private item body.
`;
}

export async function scaffoldAgentIntegration({
  client,
  outputDir,
  dataDir,
  nodePath = process.execPath,
  cliPath = fileURLToPath(new URL('./cli.mjs', import.meta.url)),
}) {
  if (!['codex', 'claude'].includes(client)) {
    throw scaffoldError('invalid_client', 'Agent client must be codex or claude');
  }
  const destination = requireAbsolute(outputDir, 'Agent scaffold destination');
  const libraryPath = requireAbsolute(dataDir, 'Social Memory data directory');
  const executable = requireAbsolute(nodePath, 'Node executable');
  const cli = requireAbsolute(cliPath, 'Social Memory CLI');
  const temporary = `${destination}.partial-${process.pid}`;

  try {
    await access(destination);
    throw scaffoldError('agent_destination_exists', 'Agent scaffold destination already exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  try {
    await mkdir(temporary, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') {
      throw scaffoldError('agent_destination_exists', 'Agent scaffold destination already exists');
    }
    throw error;
  }
  try {
    const skillSource = fileURLToPath(new URL('../skills/social-memory', import.meta.url));
    const skillTarget = join(temporary, 'skills', 'social-memory');
    await mkdir(join(temporary, 'skills'), { mode: 0o700 });
    await cp(skillSource, skillTarget, { recursive: true, errorOnExist: true });
    const definition = commandDefinition({ nodePath: executable, cliPath: cli, dataDir: libraryPath });
    if (client === 'codex') {
      await writeFile(join(temporary, 'mcp.toml'), codexToml(definition), { mode: 0o600 });
    } else {
      await writeFile(
        join(temporary, '.mcp.json'),
        `${JSON.stringify({ mcpServers: { 'social-memory': definition } }, null, 2)}\n`,
        { mode: 0o600 },
      );
    }
    await writeFile(join(temporary, 'INSTALL.md'), installNotes(client), { mode: 0o600 });
    try {
      await rename(temporary, destination);
    } catch (error) {
      if (error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST') {
        throw scaffoldError('agent_destination_exists', 'Agent scaffold destination already exists');
      }
      throw error;
    }
    return {
      status: 'created',
      client,
      outputDir: destination,
      configFile: join(destination, client === 'codex' ? 'mcp.toml' : '.mcp.json'),
      skillDir: join(destination, 'skills', 'social-memory'),
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
