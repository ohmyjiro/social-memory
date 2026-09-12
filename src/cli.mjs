#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { configureAccount, listAccounts } from './accounts.mjs';
import { CAPTURE_KINDS } from './capture-kinds.mjs';
import { initializeLibrary, loadConfig } from './config.mjs';
import { fixtureConnector } from './connectors/fixture.mjs';
import { createConnectorRegistry } from './connectors/registry.mjs';
import { openDatabase } from './db.mjs';
import { startStdioMcp } from './mcp.mjs';
import { getSource, searchSources } from './search.mjs';
import { runSync } from './sync.mjs';

function parseArguments(args) {
  const positional = [];
  const options = {};
  const valueFlags = new Set([
    '--data-dir', '--account', '--include', '--connector', '--kind', '--since', '--limit',
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--json') {
      options.json = true;
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

export async function runCli(args, {
  env = process.env,
  stdout = process.stdout,
  registry = createConnectorRegistry([fixtureConnector]),
} = {}) {
  const { positional, options } = parseArguments(args);
  const [command, subcommand, subject] = positional;

  if (command === 'init') {
    const config = loadConfig({ ...env, SOCIAL_MEMORY_DATA_DIR: options.data_dir });
    await initializeLibrary(config);
    const result = { status: 'initialized', dataDir: config.dataDir };
    emit(stdout, result, options.json);
    return result;
  }

  const config = loadConfig(env);
  if (command === 'mcp') return startStdioMcp(config);
  const db = openDatabase(config.dbPath);
  try {
    let result;
    if (command === 'connector' && subcommand === 'list') {
      result = registry.list().map(({ id, capabilities }) => ({ id, capabilities }));
    } else if (command === 'connector' && subcommand === 'configure') {
      if (!subject) throw new Error('Connector id is required');
      if (!options.account) throw new Error('--account is required');
      if (options.include === undefined) throw new Error('--include is required');
      result = configureAccount(db, registry, {
        connectorId: subject,
        identity: options.account,
        selectedCaptureKinds: options.include.split(',').map((kind) => kind.trim()),
      });
    } else if (command === 'connector' && subcommand === 'status') {
      result = listAccounts(db);
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
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
