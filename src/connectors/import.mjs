export const importConnector = Object.freeze({
  id: 'import',
  capabilities: Object.freeze(['like', 'save', 'repost', 'manual']),
  async verify({ account }) {
    return {
      status: 'ready',
      configuredIdentity: account.configuredIdentity,
      authenticatedIdentity: account.configuredIdentity,
    };
  },
  async collect() {
    return { events: [], nextCursor: null };
  },
});
