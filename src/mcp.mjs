import { createInterface } from 'node:readline';

import { CAPTURE_KINDS } from './capture-kinds.mjs';
import { loadConfig } from './config.mjs';
import { openDatabase } from './db.mjs';
import { getSource, searchSources } from './search.mjs';

const PROTOCOL_VERSION = '2025-11-25';
const readOnlyAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const tools = Object.freeze([
  {
    name: 'search_sources',
    description: 'Search locally stored social sources and filter by exact capture kind.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        connectorId: { type: 'string' },
        accountId: { type: 'integer' },
        kinds: { type: 'array', items: { enum: CAPTURE_KINDS } },
        since: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
    annotations: readOnlyAnnotations,
  },
  {
    name: 'get_source',
    description: 'Get one source with all capture and evidence provenance.',
    inputSchema: {
      type: 'object',
      properties: { sourceId: { type: 'integer' } },
      required: ['sourceId'],
      additionalProperties: false,
    },
    annotations: readOnlyAnnotations,
  },
  {
    name: 'list_capture_kinds',
    description: 'List canonical capture kinds without collapsing likes and saves.',
    inputSchema: { type: 'object', additionalProperties: false },
    annotations: readOnlyAnnotations,
  },
  {
    name: 'get_health',
    description: 'Get local library counts and readiness state.',
    inputSchema: { type: 'object', additionalProperties: false },
    annotations: readOnlyAnnotations,
  },
]);

function response(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolResult(structuredContent) {
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: false,
  };
}

function getHealth(db) {
  const count = (table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  return {
    status: 'ready',
    accounts: count('accounts'),
    sources: count('sources'),
    captures: count('captures'),
    evidence: count('evidence'),
  };
}

export async function handleMcpRequest(request, { db }) {
  if (!request || request.jsonrpc !== '2.0') return errorResponse(request?.id ?? null, -32600, 'Invalid Request');
  if (request.method === 'notifications/initialized') return null;
  if (request.method === 'ping') return response(request.id, {});
  if (request.method === 'initialize') {
    return response(request.id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'social-memory', version: '0.1.0' },
      instructions: 'Search local evidence and retain the distinction between likes, saves, and reposts.',
    });
  }
  if (request.method === 'tools/list') return response(request.id, { tools });
  if (request.method !== 'tools/call') return errorResponse(request.id, -32601, 'Method not found');

  const name = request.params?.name;
  const args = request.params?.arguments ?? {};
  try {
    if (name === 'search_sources') {
      return response(request.id, toolResult({ sources: searchSources(db, args) }));
    }
    if (name === 'get_source') {
      return response(request.id, toolResult({ source: getSource(db, args.sourceId) }));
    }
    if (name === 'list_capture_kinds') {
      return response(request.id, toolResult({ captureKinds: CAPTURE_KINDS }));
    }
    if (name === 'get_health') {
      return response(request.id, toolResult(getHealth(db)));
    }
    return errorResponse(request.id, -32601, 'Tool not found');
  } catch (error) {
    return response(request.id, {
      content: [{ type: 'text', text: error.message }],
      isError: true,
    });
  }
}

export function startStdioMcp(config = loadConfig(process.env)) {
  const db = openDatabase(config.dbPath);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', async (line) => {
    let result;
    try {
      result = await handleMcpRequest(JSON.parse(line), { db, config });
    } catch {
      result = errorResponse(null, -32700, 'Parse error');
    }
    if (result) process.stdout.write(`${JSON.stringify(result)}\n`);
  });
  lines.on('close', () => db.close());
}
