#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { configureAccount, connectAccount, listAccounts } from './accounts.mjs';
import { scaffoldAgentIntegration } from './agent-scaffold.mjs';
import { createBackup, restoreBackup } from './backup.mjs';
import { CAPTURE_KINDS } from './capture-kinds.mjs';
import { initializeLibrary, loadConfig } from './config.mjs';
import { fixtureConnector } from './connectors/fixture.mjs';
import { importConnector } from './connectors/import.mjs';
import { createThreadsConnector, threadsConnector } from './connectors/threads.mjs';
import {
  createChromeThreadsBridge,
  createChromeXBridge,
  createChromeSession,
  openChromeProfile as openChromeProfileInBrowser,
} from './connectors/chrome.mjs';
import { createXAsideConnector, xAsideConnector } from './connectors/x-aside.mjs';
import { xConnector } from './connectors/x.mjs';
import { createConnectorRegistry } from './connectors/registry.mjs';
import { openDatabase } from './db.mjs';
import { startStdioMcp } from './mcp.mjs';
import { getSource, searchSources } from './search.mjs';
import { createLaunchAgentManager, scheduleReadiness } from './scheduler.mjs';
import { runSync } from './sync.mjs';
import { importCaptureFile } from './import-file.mjs';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `Usage: social-memory <command> [options]

Commands:
  init --data-dir <absolute-path> [--json]
  doctor [--json]
  backup create --output <absolute-directory> [--json]
  backup restore --from <absolute-directory> --data-dir <absolute-path> [--json]
  import --file <absolute-json> --account <identity> --include like,save,repost [--json]
  connector list [--json]
  connector configure <connector> --account <identity> --include like,save,repost [--profile-ref <id>] [--json]
  connector status [--json]
  connector connect <connector> --include <like,save,repost> [--profile-ref <id>] [--json]
  browser open x|threads [--profile-ref <id>] [--json]
  browser open --profile-ref <id> --url <http-or-https-url> [--json]
  schedule readiness [--json]
  schedule install --interval-minutes <n> [--json]
  schedule status [--json]
  schedule uninstall [--json]
  agent scaffold --client codex|claude --output <absolute-directory> [--json]
  sync [--connector <id>] [--account <local-id>] [--kind <kind>] [--limit <n>] [--json]
  search <query> [--kind <kind>] [--connector <id>] [--since <ISO-date>] [--limit <n>] [--json]
  source <local-id> [--json]
  health [--json]
  mcp

Global options:
  --help       Show this help
  --version    Show the installed version
`;

function parseArguments(args) {
  const positional = [];
  const options = {};
  const valueFlags = new Set([
    '--data-dir', '--account', '--include', '--connector', '--kind', '--since', '--limit', '--file',
    '--credential-env', '--profile-ref', '--keychain-service', '--keychain-user',
    '--interval-minutes',
    '--output', '--from', '--client', '--url',
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--json' || token === '--help' || token === '--version' || token === '--scheduled') {
      options[token.slice(2)] = true;
    } else if (valueFlags.has(token)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Missing value for ${token}`);
      }
      options[token.slice(2).replaceAll('-', '_')] = value;
      index += 1;
    } else if (token.startsWith('--')) {
      throw new Error(`Unknown option: ${token}`);
    } else {
      positional.push(token);
    }
  }
  return { positional, options };
}

function emit(stdout, value, json) {
  const rendered = json || typeof value !== 'string'
    ? JSON.stringify(value, null, json ? 2 : 0)
    : value;
  stdout.write(`${rendered}\n`);
}

function health(db) {
  const count = (table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  return {
    status: 'ready',
    accounts: count('accounts'),
    sources: count('sources'),
    captures: count('captures'),
    evidence: count('evidence'),
  };
}

function executableAvailable(command) {
  return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
}

function doctor(config, commandAvailable) {
  const checks = {
    node: {
      status: satisfiesNodeVersion(process.versions.node, '22.16.0') ? 'pass' : 'fail',
      version: process.versions.node,
      required: '>=22.16',
    },
  };

  let dataDetails;
  let dbDetails;
  let configDetails;
  try {
    dataDetails = statSync(config.dataDir);
    dbDetails = statSync(config.dbPath);
    configDetails = statSync(config.configPath);
  } catch {
    checks.library = { status: 'fail', reason: 'not_initialized', dataDir: config.dataDir };
    return { status: 'needs_setup', checks };
  }

  checks.library = { status: 'pass', dataDir: config.dataDir };
  const privateModes =
    (dataDetails.mode & 0o777) === 0o700 &&
    (dbDetails.mode & 0o777) === 0o600 &&
    (configDetails.mode & 0o777) === 0o600;
  checks.permissions = {
    status: privateModes ? 'pass' : 'fail',
    dataDirMode: (dataDetails.mode & 0o777).toString(8),
    databaseMode: (dbDetails.mode & 0o777).toString(8),
    configMode: (configDetails.mode & 0o777).toString(8),
  };

  const db = openDatabase(config.dbPath);
  try {
    const version = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version;
    checks.schema = { status: version === 3 ? 'pass' : 'fail', version };
    const asideConnectors = db.prepare(`
      SELECT DISTINCT connector_id
      FROM accounts
      WHERE connector_id IN ('threads', 'x-aside')
      ORDER BY connector_id
    `).all().map(({ connector_id: connectorId }) => connectorId);
    if (asideConnectors.length > 0) {
      checks.aside = commandAvailable('aside')
        ? { status: 'pass', requiredBy: asideConnectors }
        : { status: 'fail', reason: 'cli_not_found', requiredBy: asideConnectors };
    }
  } finally {
    db.close();
  }

  const ready = Object.values(checks).every(({ status }) => status === 'pass');
  return { status: ready ? 'ready' : 'needs_attention', checks };
}

export function satisfiesNodeVersion(actual, minimum) {
  const parse = (value) => String(value).split('.').map((part) => Number(part));
  const left = parse(actual);
  const right = parse(minimum);
  for (let index = 0; index < 3; index += 1) {
    if ((left[index] ?? 0) > (right[index] ?? 0)) return true;
    if ((left[index] ?? 0) < (right[index] ?? 0)) return false;
  }
  return true;
}

export function exitCodeForResult(result) {
  return ['failed', 'partial', 'no_streams', 'needs_setup', 'needs_attention'].includes(result?.status)
    ? 2
    : 0;
}

export async function runCli(args, {
  env = process.env,
  stdout = process.stdout,
  registry = createConnectorRegistry([
    fixtureConnector,
    importConnector,
    xConnector,
    createXAsideConnector({
      id: 'x-chrome',
      browserBridge: createChromeXBridge({ session: createChromeSession({ env }) }),
      bookmarkLandmark: 'bookmarks_state',
      bookmarkItemLandmark: 'post_permalink',
    }),
    xAsideConnector,
    createThreadsConnector({ id: 'threads-chrome', browserBridge: createChromeThreadsBridge({ session: createChromeSession({ env }) }) }),
    threadsConnector,
  ]),
  scheduleManager = createLaunchAgentManager(),
  commandAvailable = executableAvailable,
  openChromeProfile = openChromeProfileInBrowser,
} = {}) {
  const { positional, options } = parseArguments(args);
  const [command, subcommand, subject] = positional;

  if (options.help) {
    stdout.write(HELP);
    return { status: 'help' };
  }
  if (options.version) {
    stdout.write(`${packageJson.version}\n`);
    return { status: 'version', version: packageJson.version };
  }

  if (command === 'init') {
    const config = loadConfig({ ...env, SOCIAL_MEMORY_DATA_DIR: options.data_dir });
    await initializeLibrary(config);
    const result = { status: 'initialized', dataDir: config.dataDir };
    emit(stdout, result, options.json);
    return result;
  }
  if (command === 'backup' && subcommand === 'restore') {
    if (!options.from) throw new Error('--from is required');
    if (!options.data_dir) throw new Error('--data-dir is required');
    const result = await restoreBackup({ backupDir: options.from, dataDir: options.data_dir });
    emit(stdout, result, options.json);
    return result;
  }

  const config = loadConfig(env);
  if (command === 'browser' && subcommand === 'open') {
    const defaults = {
      x: { profileRef: 'x-default', url: 'https://x.com/home' },
      threads: { profileRef: 'threads-default', url: 'https://www.threads.com/' },
    }[subject];
    const profileRef = options.profile_ref ?? defaults?.profileRef;
    const url = options.url ?? defaults?.url;
    if (!profileRef) throw new Error('--profile-ref is required');
    if (!url) throw new Error('--url is required');
    const result = await openChromeProfile({
      profileRoot: join(config.dataDir, 'chrome-profiles'),
      profileRef,
      url,
    });
    emit(stdout, result, options.json);
    return result;
  }
  if (command === 'doctor') {
    const result = doctor(config, commandAvailable);
    emit(stdout, result, options.json);
    return result;
  }
  if (command === 'mcp') return startStdioMcp(config);
  const db = openDatabase(config.dbPath);
  try {
    let result;
    if (command === 'connector' && subcommand === 'list') {
      result = registry.list().map(({ id, capabilities }) => ({ id, capabilities }));
    } else if (command === 'connector' && subcommand === 'connect') {
      if (!subject) throw new Error('Connector id is required');
      if (!options.include) throw new Error('--include is required');
      result = await connectAccount(db, registry, {
        connectorId: subject,
        profileRef: options.profile_ref,
        selectedCaptureKinds: options.include.split(',').map((kind) => kind.trim()),
      });
    } else if (command === 'connector' && subcommand === 'configure') {
      if (!subject) throw new Error('Connector id is required');
      if (!options.account) throw new Error('--account is required');
      if (options.include === undefined) throw new Error('--include is required');
      result = configureAccount(db, registry, {
        connectorId: subject,
        identity: options.account,
        profileRef: options.profile_ref,
        selectedCaptureKinds: options.include.split(',').map((kind) => kind.trim()),
        connectorConfig: options.keychain_service || options.keychain_user
          ? {
              keychainService: options.keychain_service,
              keychainAccount: options.keychain_user,
            }
          : options.credential_env
            ? { credentialEnv: options.credential_env }
            : undefined,
      });
    } else if (command === 'connector' && subcommand === 'status') {
      result = listAccounts(db);
    } else if (command === 'import') {
      if (!options.file) throw new Error('--file is required');
      if (!options.account) throw new Error('--account is required');
      if (options.include === undefined) throw new Error('--include is required');
      result = await importCaptureFile({
        db,
        config,
        registry,
        filePath: options.file,
        accountIdentity: options.account,
        selectedCaptureKinds: options.include.split(',').map((kind) => kind.trim()),
      });
    } else if (command === 'sync') {
      result = await runSync({
        db,
        config,
        registry,
        filters: {
          connectorId: options.connector,
          accountId: options.account,
          kind: options.kind,
        },
        limit: options.limit === undefined ? 100 : Number(options.limit),
        trigger: options.scheduled ? 'scheduled' : 'manual',
      });
    } else if (command === 'schedule' && subcommand === 'readiness') {
      result = scheduleReadiness(db);
    } else if (command === 'schedule' && subcommand === 'install') {
      if (options.interval_minutes === undefined) throw new Error('--interval-minutes is required');
      result = await scheduleManager.install({
        db,
        config,
        intervalMinutes: Number(options.interval_minutes),
      });
    } else if (command === 'schedule' && subcommand === 'status') {
      result = await scheduleManager.status({ config });
    } else if (command === 'schedule' && subcommand === 'uninstall') {
      result = await scheduleManager.uninstall({ config });
    } else if (command === 'backup' && subcommand === 'create') {
      if (!options.output) throw new Error('--output is required');
      result = await createBackup({ db, config, outputDir: options.output });
    } else if (command === 'agent' && subcommand === 'scaffold') {
      if (!options.client) throw new Error('--client is required');
      if (!options.output) throw new Error('--output is required');
      result = await scaffoldAgentIntegration({
        client: options.client,
        outputDir: options.output,
        dataDir: config.dataDir,
      });
    } else if (command === 'search') {
      result = searchSources(db, {
        query: positional.slice(1).join(' '),
        connectorId: options.connector,
        kinds: options.kind ? [options.kind] : undefined,
        since: options.since,
        limit: options.limit,
      });
    } else if (command === 'source') {
      if (!subcommand) throw new Error('Source id is required');
      result = getSource(db, subcommand);
    } else if (command === 'health') {
      result = health(db);
    } else {
      throw new Error(`Unknown command: ${positional.join(' ') || '(empty)'}`);
    }
    emit(stdout, result, options.json);
    return result;
  } finally {
    db.close();
  }
}

export { health };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2))
    .then((result) => { process.exitCode = exitCodeForResult(result); })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
