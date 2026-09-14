#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { initializeLibrary, loadConfig } from './config.mjs';
import { createConnectorRegistry } from './connectors/registry.mjs';
import { openDatabase } from './db.mjs';
import {
  connectExtension,
  extensionConnectors,
  getExtensionConnection,
  ingestExtensionBatch,
} from './extension-connections.mjs';

const PROTOCOL_VERSION = 1;
const MAX_INBOUND_BYTES = 2 * 1024 * 1024;
const MAX_OUTBOUND_BYTES = 1024 * 1024;

export function encodeNativeMessage(value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.length > MAX_OUTBOUND_BYTES) throw new Error('Native message is too large');
  const framed = Buffer.allocUnsafe(body.length + 4);
  framed.writeUInt32LE(body.length, 0);
  body.copy(framed, 4);
  return framed;
}

export function createNativeMessageDecoder({ maxBytes = MAX_INBOUND_BYTES } = {}) {
  let buffered = Buffer.alloc(0);
  return Object.freeze({
    push(chunk) {
      buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
      const messages = [];
      while (buffered.length >= 4) {
        const length = buffered.readUInt32LE(0);
        if (length > maxBytes) throw new Error('Native message is too large');
        if (buffered.length < length + 4) break;
        messages.push(JSON.parse(buffered.subarray(4, length + 4).toString('utf8')));
        buffered = buffered.subarray(length + 4);
      }
      return messages;
    },
  });
}

function response(id, ok, value) {
  return ok
    ? { version: PROTOCOL_VERSION, id, ok: true, result: value }
    : { version: PROTOCOL_VERSION, id, ok: false, error: value };
}

function validRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return false;
  const keys = Object.keys(request).sort();
  return JSON.stringify(keys) === JSON.stringify(['id', 'method', 'params', 'version']) &&
    request.version === PROTOCOL_VERSION &&
    typeof request.id === 'string' && request.id.length > 0 && request.id.length <= 128 &&
    typeof request.method === 'string' &&
    request.params && typeof request.params === 'object' && !Array.isArray(request.params);
}

export async function handleExtensionRequest(context, request) {
  const id = typeof request?.id === 'string' ? request.id : null;
  if (!validRequest(request)) {
    return response(id, false, { code: 'invalid_request', message: 'Invalid native message request' });
  }
  if (!['health', 'connect', 'status', 'ingest'].includes(request.method)) {
    return response(id, false, { code: 'unknown_method', message: `Unknown method: ${request.method}` });
  }
  try {
    const result = request.method === 'health'
      ? { status: 'ready', protocolVersion: PROTOCOL_VERSION }
      : await context[request.method](request.params);
    return response(id, true, result);
  } catch (error) {
    return response(id, false, {
      code: typeof error?.code === 'string' ? error.code : 'invalid_request',
      message: error?.message || 'Request failed',
    });
  }
}

async function defaultContext(env) {
  const config = loadConfig(env);
  await initializeLibrary(config);
  const db = openDatabase(config.dbPath);
  const registry = createConnectorRegistry(extensionConnectors);
  return {
    connect: (params) => connectExtension(db, registry, params),
    status: ({ installationId, platform }) => getExtensionConnection(db, installationId, platform),
    ingest: (params) => ingestExtensionBatch(db, config, params),
    close: () => db.close(),
  };
}

export async function runNativeHost({
  input = process.stdin,
  output = process.stdout,
  error = process.stderr,
  env = process.env,
  createContext = () => defaultContext(env),
} = {}) {
  const decoder = createNativeMessageDecoder();
  const context = await createContext();
  error.write('Social Memory native host ready\n');
  try {
    for await (const chunk of input) {
      for (const request of decoder.push(chunk)) {
        output.write(encodeNativeMessage(await handleExtensionRequest(context, request)));
      }
    }
  } catch (hostError) {
    error.write(`Social Memory native host error: ${hostError.message}\n`);
    output.write(encodeNativeMessage(response(null, false, {
      code: 'protocol_error',
      message: 'Native messaging protocol error',
    })));
  } finally {
    await context.close?.();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runNativeHost().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
