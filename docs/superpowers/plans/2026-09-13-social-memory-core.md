# Social Memory Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build an offline-testable Social Memory core that preserves distinct like/save/repost captures, copies local Evidence into a content-addressed library, supports exact filtered search, and exposes read-only MCP tools.

**Architecture:** A dependency-free Node.js 22.5+ CLI owns a SQLite library and a registry of connector objects. The first slice ships only a synthetic fixture connector; X and Threads remain later packages behind the same verified account/kind/cursor contract. Domain modules are independent of CLI and MCP rendering.

**Tech Stack:** Node.js ESM, built-in `node:sqlite`, `node:test`, SQLite FTS5, JSON-RPC MCP over stdio.

**Spec:** `docs/superpowers/specs/2026-09-13-social-memory-mvp-design.md`

**Execution result:** Completed on `feature/core-mvp` on 2026-09-13. The source-tree suite and clean-copy smoke each pass 18 tests. The fixture proves local contracts only; live X/Threads adapters remain deferred.

## Global Constraints

- Require Node.js 22.5 or newer and add no production dependency.
- Keep runtime data outside the repository and use mode `0700` directories and mode `0600` configuration/database files where supported.
- Treat `like`, `save`, `repost`, and `manual` as distinct canonical capture kinds; X bookmark and Threads saved map to `save` while retaining `nativeKind`.
- Require a non-empty explicit `selectedCaptureKinds` subset per account and never delete old captures when the selection changes.
- Store no passwords, cookies, access tokens, OTPs, or browser profile contents.
- Use only fictional fixtures and make no network or browser calls in core tests.
- MCP remains read-only.

---

### Task 1: Library configuration and schema

**Files:**
- Create: `package.json`
- Create: `.gitignore`
- Create: `src/config.mjs`
- Create: `src/db.mjs`
- Create: `src/schema.sql`
- Test: `test/library.test.mjs`

**Interfaces:**
- Produces: `loadConfig(env): LibraryConfig`, `initializeLibrary(config): Promise<void>`, `openDatabase(dbPath): DatabaseSync`.
- `LibraryConfig` fields: `dataDir`, `dbPath`, `objectsDir`, `stagingDir`, `configPath`.

- [x] **Step 1: Write the failing configuration and schema tests**

Create real temporary directories and assert that `loadConfig` rejects a relative `SOCIAL_MEMORY_DATA_DIR`; `initializeLibrary` creates mode-private directories and configuration; `openDatabase` exposes `connectors`, `accounts`, `account_capture_kinds`, `sources`, `captures`, `evidence`, `objects`, `collection_runs`, `sync_cursors`, and `sources_fts`.

```js
assert.throws(() => loadConfig({ SOCIAL_MEMORY_DATA_DIR: 'relative' }), /absolute/);
await initializeLibrary(loadConfig({ SOCIAL_MEMORY_DATA_DIR: dataDir }));
assert.equal(statSync(dataDir).mode & 0o777, 0o700);
assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name='captures'").get(), { name: 'captures' });
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `node --test test/library.test.mjs`  
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `src/config.mjs`.

- [x] **Step 3: Implement the minimum library modules and schema**

Use `resolve`, `isAbsolute`, `mkdir`, and `writeFile` in `config.mjs`; use `DatabaseSync` and `schema.sql` in `db.mjs`. Define foreign keys and uniqueness:

```sql
UNIQUE(connector_id, external_id)
UNIQUE(account_id, source_id, kind)
UNIQUE(account_id, kind)
CHECK(kind IN ('like','save','repost','manual'))
```

Use FTS5 external-content triggers for Source text, author, and canonical URL. Evidence text is synchronized into a separate FTS column by the ingestion module rather than hidden trigger magic.

- [x] **Step 4: Run the focused test and verify GREEN**

Run: `node --test test/library.test.mjs`  
Expected: all library tests PASS with no runtime warning after using `--disable-warning=ExperimentalWarning` in the package test command.

- [x] **Step 5: Commit the tested library foundation**

Commit the Task 1 files with a Lore-format message recording Node/SQLite constraints and the focused test.

### Task 2: Connector registry and explicit capture selection

**Files:**
- Create: `src/capture-kinds.mjs`
- Create: `src/connectors/registry.mjs`
- Create: `src/connectors/fixture.mjs`
- Create: `src/accounts.mjs`
- Test: `test/accounts.test.mjs`

**Interfaces:**
- Consumes: `openDatabase(dbPath)` from Task 1.
- Produces: `CAPTURE_KINDS`, `createConnectorRegistry(connectors)`, `configureAccount(db, registry, input)`, `listAccounts(db)`.
- `configureAccount` input: `{ connectorId, identity, profileRef?, selectedCaptureKinds }`.

- [x] **Step 1: Write failing behavior tests for reaction distinction and selection**

Assert with the real database that configuration rejects empty, duplicate, unknown, and unsupported kinds; normalizes kind order; and preserves old capture rows during reconfiguration. Assert the fixture connector advertises exactly `like`, `save`, and `repost`.

```js
assert.throws(() => configureAccount(db, registry, {
  connectorId: 'fixture', identity: 'reader_one', selectedCaptureKinds: []
}), /select at least one/);
const account = configureAccount(db, registry, {
  connectorId: 'fixture', identity: 'reader_one', selectedCaptureKinds: ['save', 'like']
});
assert.deepEqual(account.selectedCaptureKinds, ['like', 'save']);
```

Name the mutation caught: treating `save` as `like`, silently enabling all kinds, or deleting existing captures on reconfiguration must fail at least one test.

- [x] **Step 2: Run the focused test and verify RED**

Run: `node --test test/accounts.test.mjs`  
Expected: FAIL because the registry and account modules do not exist.

- [x] **Step 3: Implement validation, registry, and fixture account configuration**

Keep the canonical kind set in one module. The registry rejects duplicate connector IDs and freezes capability arrays. Account configuration uses a transaction to upsert the account and replace only rows in `account_capture_kinds`; it never touches `captures`.

- [x] **Step 4: Run Task 1 and Task 2 tests**

Run: `node --test test/library.test.mjs test/accounts.test.mjs`  
Expected: PASS.

- [x] **Step 5: Commit the capture-selection contract**

Commit Task 2 files with `Directive:` noting that like/save must never be collapsed.

### Task 3: Source, Capture, and content-addressed Evidence ingestion

**Files:**
- Create: `src/ingest.mjs`
- Create: `src/evidence-store.mjs`
- Test: `test/ingest.test.mjs`
- Create: `fixtures/files/sample-note.txt`

**Interfaces:**
- Consumes: Task 1 database, Task 2 canonical capture kinds.
- Produces: `ingestCaptureBatch(db, config, account, kind, events)`, `storeObject(config, filePath)`.
- Batch result: `{ insertedSources, insertedCaptures, updatedCaptures, insertedEvidence, storedObjects }`.

- [x] **Step 1: Write failing transaction and deduplication tests**

Use literal synthetic events. Ingest the same external Source once through `like`/`favorite` and once through `save`/`bookmark`. Assert one Source, two Captures with distinct canonical kinds and retained `native_kind`. Re-run and assert no duplicates. Ingest the same file twice and assert one SHA-256 object and two Evidence references. Pass one malformed event in a batch and assert zero rows from that batch.

- [x] **Step 2: Run the focused test and verify RED**

Run: `node --test test/ingest.test.mjs`  
Expected: FAIL because `src/ingest.mjs` is absent.

- [x] **Step 3: Implement strict normalization and object storage**

Validate URLs with `URL`, timestamps with finite `Date`, and stable external IDs as non-empty strings. Copy file bytes to `objects/<hash[0:2]>/<hash[2:]>` using exclusive creation and atomic rename. Store only object-relative POSIX paths. Reject file paths outside the caller-selected input when the input is missing or not a regular file.

Wrap each event batch in one database transaction. Upsert Source observation fields, Capture `last_observed_at`, and Evidence records without merging canonical capture kinds.

- [x] **Step 4: Run all core tests and verify GREEN**

Run: `npm test`  
Expected: Task 1-3 tests PASS.

- [x] **Step 5: Commit evidence ingestion**

Commit with `Tested:` naming transactional malformed-batch rejection and SHA-256 deduplication.

### Task 4: Per-kind sync isolation

**Files:**
- Create: `src/sync.mjs`
- Update: `src/connectors/fixture.mjs`
- Test: `test/sync.test.mjs`

**Interfaces:**
- Consumes: `listAccounts`, registry connectors, `ingestCaptureBatch`.
- Produces: `runSync({ db, config, registry, filters?, limit?, clock? })`.
- Summary: `{ status, streams: [{ accountId, connectorId, kind, status, count, errorCode }] }`.

- [x] **Step 1: Write failing tests for exact selected calls and cursor safety**

Configure one fixture account for `like` and `save`, and another for `repost`. Assert exactly those three connector streams run. Make the save stream fail after the like stream succeeds; assert only the like cursor advances and the run summary is `partial`. Assert an identity mismatch makes zero collection calls and records configured/authenticated identities without secrets.

- [x] **Step 2: Run the focused test and verify RED**

Run: `node --test test/sync.test.mjs`  
Expected: FAIL because `runSync` is absent.

- [x] **Step 3: Implement sequential, fail-closed stream sync**

Verify once per account, normalize identities case-insensitively after removing one leading `@`, and collect each selected kind independently. Insert a `collection_runs` row per stream. Advance `sync_cursors` only after `ingestCaptureBatch` commits. Redact error details to code and safe message fields.

- [x] **Step 4: Run the complete suite and verify GREEN**

Run: `npm test`  
Expected: all tests PASS.

- [x] **Step 5: Commit isolated sync behavior**

Commit with `Directive:` stating that cursor scope is account plus capture kind.

### Task 5: Provenance-preserving search

**Files:**
- Create: `src/search.mjs`
- Test: `test/search.test.mjs`

**Interfaces:**
- Consumes: Task 1 schema and Task 3 ingested records.
- Produces: `searchSources(db, { query, connectorId?, accountId?, kinds?, since?, limit? })`, `getSource(db, sourceId)`.

- [x] **Step 1: Write failing lexical and metadata-filter tests**

Seed Sources whose content deliberately separates keyword, author, and Evidence matches. Assert hand-derived result IDs for blank recent listing, FTS match, `like` only, `save` only, connector, account, and ISO-date filters. Assert one Source matched by both reactions returns `captureKinds: ['like','save']` and distinct native kinds.

- [x] **Step 2: Run the focused test and verify RED**

Run: `node --test test/search.test.mjs`  
Expected: FAIL because search functions are absent.

- [x] **Step 3: Implement bounded FTS and exact filters**

Escape FTS tokens, cap `limit` at 100, use parameterized SQL, and assemble provenance without returning raw connector JSON by default. `getSource` returns all Captures and Evidence but omits stored raw payload unless an internal diagnostic API explicitly requests it in a later phase.

- [x] **Step 4: Run the complete suite and verify GREEN**

Run: `npm test`  
Expected: all tests PASS.

- [x] **Step 5: Commit search behavior**

Commit with `Tested:` naming exact like/save filtering and Evidence provenance.

### Task 6: CLI, read-only MCP, and clean-install proof

**Files:**
- Create: `src/cli.mjs`
- Create: `src/mcp.mjs`
- Create: `test/cli-mcp.test.mjs`
- Create: `AGENTS.md`
- Create: `.env.example`
- Update: `README.md`

**Interfaces:**
- Consumes: all Task 1-5 functions.
- Produces: executable `social-memory` CLI and stdio MCP server with `search_sources`, `get_source`, `list_capture_kinds`, `get_health`.

- [x] **Step 1: Write failing CLI and MCP boundary tests**

Run `runCli` with a real temporary library and captured output. Assert account configuration prints the selected kinds, fixture sync creates separately searchable like/save captures, and reconfiguration leaves old rows. Send JSON-RPC `initialize`, `tools/list`, and `tools/call` requests to `handleMcpRequest`; assert only four read-only tools and reject unknown/mutating tools.

- [x] **Step 2: Run the focused test and verify RED**

Run: `node --test test/cli-mcp.test.mjs`  
Expected: FAIL because CLI/MCP modules are absent.

- [x] **Step 3: Implement deterministic command and MCP adapters**

Parse only the documented flags, reject missing option values, and return stable JSON under `--json`. Keep CLI parsing separate from domain functions. MCP tool results include `structuredContent` and read-only annotations and never call sync/configuration code.

- [x] **Step 4: Document installation and privacy boundaries**

Document Node requirement, an absolute private data path, fixture-only first run, distinct collection options, no credential persistence, and the boundary between fixture/local/live proof. `.env.example` uses fictional values and is not auto-loaded.

- [x] **Step 5: Run release verification from the source tree**

Run: `npm test && npm run check`  
Expected: all tests and syntax checks PASS with no warnings.

- [x] **Step 6: Run a clean-copy smoke test from a path containing spaces**

Copy tracked files into a temporary `social memory smoke` directory, set a different absolute data directory, then run `npm test`, `init`, fixture account configuration with `--include like,save`, fixture sync, kind-filtered search, and MCP `initialize`. Expected: every command exits zero and the two filters return the same Source with different Capture provenance.

- [x] **Step 7: Run a private-data and runtime-artifact scan**

Scan tracked files and full Git history for home-directory paths, private account identities, credentials, SQLite files, `.env`, browser profile data, and actual collected content. Expected: no violation. Synthetic fixtures are the only content records.

- [x] **Step 8: Commit the verified core slice**

Commit CLI, MCP, docs, and tests with Lore trailers listing the complete test and smoke evidence. Do not create a public GitHub repository until the license is selected.

## Plan self-review result

- Spec coverage: all ten core acceptance criteria map to Tasks 1-6.
- Deferred scope: live X/Threads, OCR/media enrichment, scheduler, migration, distribution, vector search, and remote ChatGPT bridge remain explicitly outside this plan.
- Type consistency: capture kinds, account selection, connector event, sync summary, search result, and MCP names match the design specification.
- Placeholder scan: no unfinished implementation instruction remains.
