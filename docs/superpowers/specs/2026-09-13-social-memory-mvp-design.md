# Social Memory MVP Design

## Status

Approved direction as of 2026-09-13. This specification incorporates the later requirement that likes and saves/bookmarks are distinct collection signals and must be selectable per account.

## Objective

Build a local-first, open-source service that collects a user's selected reactions from X and Threads, preserves source evidence in a private local library, and exposes deterministic search to subscription-based agent clients without embedding a paid LLM in the product.

The first implementation targets Claude Code and Codex power users on macOS. Claude Desktop can use the local MCP surface. ChatGPT connectivity is documented as limited because it cannot connect directly to a local MCP server; a remote bridge is not part of the first implementation.

## Delivery decomposition

The product contains three independently verifiable subprojects and must be implemented in order.

1. **Core library:** generic source, capture, evidence, connector-configuration, search, CLI, fixture connector, and read-only MCP behavior.
2. **Live social connectors:** isolated-profile X and Threads verification and collection using the core connector contract.
3. **Distribution:** agent skill, installer, background scheduling, migration from the existing private archive, and release packaging.

This specification covers the complete MVP boundary. The first implementation plan covers only the core library so that every later subsystem depends on a tested contract rather than social-platform details.

## Product boundary

Social Memory is not a new general-purpose RAG engine and does not ship a chat UI. It owns collection, durable local evidence, metadata search, and agent-facing retrieval. A connected agent performs high-level classification, summaries, and idea synthesis.

The core must not know X or Threads route details. A connector identifies itself, declares supported capture kinds, verifies an account, and returns normalized capture events. The first live connector package contains X and Threads adapters, but the core must also accept future file, web, video, or other connectors.

## Runtime and dependencies

- macOS is the verified operating system for the MVP.
- Node.js 22.16 or newer is required.
- The core uses built-in `node:sqlite`, `node:crypto`, and other standard modules.
- No production dependency is added in the core phase.
- Runtime data defaults to a user-selected path outside the repository.
- Tests use only fictional identities and synthetic evidence.

## Domain model

### Connector

A connector record identifies one adapter implementation, such as `fixture`, `x`, or `threads`. It declares stable connector capabilities and does not contain account credentials.

### Account

An account belongs to one connector and contains:

- a local account ID;
- the configured handle or identity label;
- an optional isolated browser profile reference;
- the latest authenticated identity and verification status;
- timestamps and a non-secret connector configuration object.

Passwords, tokens, cookies, browser profile contents, and OTPs are never stored in the library database or configuration JSON. A connector uses an isolated browser profile, OAuth, or the OS credential store.

### Capture kinds

The core defines these canonical MVP capture kinds:

- `like`: an affirmative reaction;
- `save`: a bookmark or saved-for-later action;
- `repost`: a repost or reshare action;
- `manual`: an explicit local import.

`like` and `save` are never aliases. X `bookmark` and Threads `saved` normalize to canonical `save`, while `nativeKind` retains the source platform term. A source carrying both a like and a save produces one Source and two Capture rows.

Every account configuration contains `selectedCaptureKinds`, a non-empty subset of the connector's declared capabilities. Initial setup requires explicit selection and does not silently enable all capture kinds. A sync requests only selected kinds. Removing a kind from configuration stops future collection but never deletes existing Captures or Sources. Each account and capture kind has its own cursor so one failing surface does not advance another.

### Source

A Source is the canonical external or local object being remembered. It contains:

- connector ID and stable external ID;
- canonical URL when available;
- author identity and display name when available;
- source text and source creation timestamp;
- first-collected, last-seen, and availability timestamps;
- raw connector payload retained as provenance.

`connectorId + externalId` uniquely identifies a Source. The same Source collected through multiple reactions is stored once.

### Capture

A Capture records why and when a Source entered the library. It contains the account, Source, canonical kind, original `nativeKind`, captured timestamp, first observed timestamp, and last observed timestamp.

The MVP keeps at most one active observation row for `accountId + sourceId + kind`; repeated syncs update `lastObservedAt` idempotently. Historic removal from a platform may later be modeled as state, but the core phase does not infer deletion from absence in a paginated response.

### Evidence

Evidence is content used to understand a Source. It may be:

- inline source text;
- a local file copied into the library;
- an image, PDF, audio, video, or caption file;
- extracted text, OCR, transcription, or linked-page content;
- a connector-provided alt text or metadata record.

Original files are content-addressed by SHA-256 under `objects/<first-two-hex>/<remaining-hex>`. The database stores the hash, byte size, MIME type, original filename, object-relative path, provenance, and optional parent Evidence. Duplicate bytes share one object. Derived Evidence never overwrites original Evidence.

The core phase supports inline text and local file copying. OCR, PDF extraction, and media transcription are separate enrichment work in the live connector phase.

### Collection run and cursor

Each run records account, capture kind, start and finish timestamps, status, item count, error code, and redacted details. Cursors are keyed by account and capture kind and advance only after that individual stream commits successfully.

## Connector contract

A connector module exports an object with this behavior:

```js
{
  id: 'fixture',
  capabilities: ['like', 'save', 'repost'],
  async verify({ account }) {
    return {
      status: 'ready',
      configuredIdentity: 'example_user',
      authenticatedIdentity: 'example_user'
    };
  },
  async collect({ account, kind, cursor, limit }) {
    return {
      events: [{
        externalId: 'post-1',
        canonicalUrl: 'https://example.test/post/1',
        author: { handle: 'author', name: 'Author' },
        text: 'Synthetic source text',
        sourceCreatedAt: '2026-01-02T03:04:05.000Z',
        capture: { kind: 'save', nativeKind: 'bookmark', capturedAt: null },
        evidence: []
      }],
      nextCursor: 'cursor-2'
    };
  }
}
```

The sync service rejects a collection result when:

- `kind` was not selected or is not a connector capability;
- verification status is not `ready`;
- configured and authenticated identities differ after normalization;
- an event's canonical kind differs from the stream being collected;
- a required stable external ID is missing;
- a URL or timestamp is malformed;
- the connector returns an unrecognized result shape.

Failure is isolated to one account and capture kind. No cursor advances and no partial event batch is stored for that stream.

## CLI contract

The core phase provides:

```text
social-memory init --data-dir <absolute-path>
social-memory connector list
social-memory connector configure <connector> --account <identity> --include <like,save,repost>
social-memory connector status
social-memory sync [--connector <id>] [--account <id>] [--kind <kind>] [--limit <n>]
social-memory search <query> [--kind <kind>] [--connector <id>] [--since <ISO-date>] [--json]
social-memory source <local-id> [--json]
social-memory health [--json]
social-memory mcp
```

`connector configure` fails when `--include` is empty, contains duplicates, or requests a kind the connector does not support. Reconfiguration is non-destructive.

The core phase registers only the fixture connector so installation and tests never access a live platform. Live connector registration follows in subproject two.

## Search and agent boundary

SQLite FTS5 indexes source text, author fields, Evidence text, and canonical URLs. Metadata filters for connector, account, capture kind, and dates are applied exactly. Search results contain Source IDs, canonical URLs, matched capture kinds, source excerpts, and Evidence provenance.

The read-only MCP server exposes:

- `search_sources`;
- `get_source`;
- `list_capture_kinds`;
- `get_health`.

The MCP server never triggers social collection, changes connector configuration, or writes LLM analysis. Agent Skill and CLI are the installation and operational surfaces. High-level LLM output must distinguish retrieved evidence from synthesis.

Vector embeddings, a persistent knowledge graph, and embedded model calls are not part of the core phase. They are added only after hybrid retrieval quality is measured against real user questions and cannot be solved by FTS plus agent query expansion.

## Local library layout

```text
<data-dir>/
├── social-memory.sqlite
├── config.json
├── objects/
│   └── ab/cdef...
├── staging/
├── exports/
└── logs/
```

`config.json` and database files are mode `0600`; directories are mode `0700` where supported. Object-relative paths are stored in the database so the library can be moved as a unit. The application refuses object paths that escape the configured data directory.

## Error and privacy behavior

- Account mismatch stops only that account and reports configured versus authenticated identities.
- Reauthentication preserves the archive and never asks for a password in a command or config file.
- Connector surface drift returns `connector_drift`; it is not recorded as a successful empty sync.
- A malformed event batch is rejected transactionally.
- A missing optional file is recorded as Evidence unavailable without inventing extracted content.
- External deletion sets source availability when explicitly observed but does not delete local Evidence.
- User deletion is a later explicit workflow and is not inferred from sync absence.
- Logs redact authorization headers, cookies, query tokens, and connector raw secrets.

## First implementation acceptance criteria

The core library phase is complete when:

1. a fresh checkout with Node.js 22.16+ can initialize a private library without network access;
2. fixture accounts require an explicit non-empty capture-kind selection;
3. fixture sync stores `like`, `save`, and `repost` separately while deduplicating their shared Source;
4. changing selected kinds affects future sync calls without deleting old Captures;
5. cursors advance independently per account and kind and do not advance on failure;
6. local files are copied into SHA-256 object paths and duplicate bytes are stored once;
7. search filters by capture kind and returns source/evidence provenance;
8. MCP lists and serves only the four read-only tools;
9. tests use synthetic fixtures and no live network, credentials, browser profiles, or private archive;
10. `npm test`, syntax checks, a clean-path smoke test, and a private-data scan all pass.

## Later subproject acceptance boundaries

Live X and Threads collection is not claimed merely because fixture tests pass. Each adapter requires a dedicated authenticated profile, exact identity proof, a bounded live probe for each selected capture kind, and explicit evidence that likes and saves remain distinct.

Distribution is not complete until an agent can install the project into an empty path, configure the local Skill/MCP with resolved paths, run a manual fixture sync, and report what remains at the login boundary. Scheduling is installed only after a successful manual live sync.

## Open-source and commercialization

License selection remains a release gate rather than an implementation blocker. The working candidates are a single AGPL-3.0 repository or an AGPL core with a permissive connector SDK. No public push occurs until the license and contribution model are chosen.

The free core includes local storage, basic connectors, CLI, Skill, and local MCP. Possible paid services include signed connector updates, automated recovery, encrypted sync and backup, additional maintained connectors, and an optional secure ChatGPT bridge. Pricing and paid boundaries remain hypotheses until user validation.
