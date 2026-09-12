export function createFixtureConnector({ authenticatedIdentity, streams = {} } = {}) {
  return {
    id: 'fixture',
    capabilities: Object.freeze(['like', 'save', 'repost']),
    async verify({ account }) {
      return {
        status: 'ready',
        configuredIdentity: account.configuredIdentity,
        authenticatedIdentity: authenticatedIdentity ?? account.configuredIdentity,
      };
    },
    async collect({ kind }) {
      const stream = streams[kind] ?? { events: [], nextCursor: null };
      if (stream instanceof Error) throw stream;
      return structuredClone(stream);
    },
  };
}

export const fixtureConnector = Object.freeze(createFixtureConnector());
