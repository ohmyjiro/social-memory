const sharedSource = {
  externalId: 'fixture-shared-source',
  canonicalUrl: 'https://example.test/social-memory/fixture-shared-source',
  author: { handle: 'fixture_author', name: 'Fixture Author' },
  text: 'Fixture idea about reusable social memory',
  sourceCreatedAt: '2026-01-02T03:04:05.000Z',
  evidence: [{
    kind: 'text',
    text: 'Synthetic evidence used only for an offline first run.',
    provenance: 'fixture',
  }],
};

const defaultStreams = {
  like: {
    events: [{
      ...sharedSource,
      capture: { kind: 'like', nativeKind: 'favorite', capturedAt: null },
    }],
    nextCursor: 'fixture-like-complete',
  },
  save: {
    events: [{
      ...sharedSource,
      capture: { kind: 'save', nativeKind: 'bookmark', capturedAt: null },
    }],
    nextCursor: 'fixture-save-complete',
  },
  repost: {
    events: [{
      externalId: 'fixture-repost-source',
      canonicalUrl: 'https://example.test/social-memory/fixture-repost-source',
      author: { handle: 'fixture_author', name: 'Fixture Author' },
      text: 'Fixture repost for offline verification',
      sourceCreatedAt: '2026-01-03T03:04:05.000Z',
      capture: { kind: 'repost', nativeKind: 'repost', capturedAt: null },
      evidence: [],
    }],
    nextCursor: 'fixture-repost-complete',
  },
};

export function createFixtureConnector({ authenticatedIdentity, streams = defaultStreams } = {}) {
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
