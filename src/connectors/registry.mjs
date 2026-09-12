function normalizeConnector(connector) {
  if (!connector || typeof connector.id !== 'string' || connector.id.length === 0) {
    throw new Error('Connector requires a non-empty id');
  }
  if (!Array.isArray(connector.capabilities) || connector.capabilities.length === 0) {
    throw new Error(`Connector ${connector.id} requires capabilities`);
  }

  return Object.freeze({
    ...connector,
    capabilities: Object.freeze([...connector.capabilities]),
  });
}

export function createConnectorRegistry(connectors) {
  const byId = new Map();
  for (const candidate of connectors) {
    const connector = normalizeConnector(candidate);
    if (byId.has(connector.id)) throw new Error(`Duplicate connector id: ${connector.id}`);
    byId.set(connector.id, connector);
  }

  return Object.freeze({
    get(id) {
      const connector = byId.get(id);
      if (!connector) throw new Error(`Unknown connector: ${id}`);
      return connector;
    },
    list() {
      return [...byId.values()];
    },
  });
}
