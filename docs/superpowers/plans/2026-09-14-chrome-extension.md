# Social Memory Chrome Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an unpacked Manifest V3 Chrome extension that connects the accounts already signed into each Chrome profile to the local Social Memory database through a user-scoped Native Messaging host.

**Architecture:** A popup and ephemeral service worker inspect only X and Threads pages, then send versioned, bounded messages to `com.ohmyjiro.social_memory`. The native host reuses existing account validation and ingestion, while a small `extension_connections` table maps each Chrome-profile installation ID to its verified platform account.

**Tech Stack:** Node.js 22.16+, `node:sqlite`, Chrome Manifest V3 APIs, Native Messaging stdio, existing `node:test`, HTML/CSS/JavaScript, built-in image generation.

**Spec:** `docs/superpowers/specs/2026-09-14-chrome-extension-design.md`

## Global Constraints

- Add no runtime dependency; use Node standard library and Chrome-native APIs.
- Never read or transmit passwords, cookies, OAuth tokens, browser history, or unrelated pages.
- Treat the live X or Threads handle as identity; an extension installation ID is transport scope only.
- Re-verify origin, route, collection heading, and handle before every ingestion batch.
- Keep one Source per platform and external post ID while preserving account and capture-kind provenance.
- Store durable extension state in `chrome.storage.local`; do not rely on service-worker globals or timers.
- Chrome alarms are once-daily best effort while Chrome is running, never an exact-time guarantee.
- Version 0.2 supports user-scoped Native Messaging installation on macOS and Linux; Windows remains explicitly unverified.
- English is the default README and Korean carries equivalent usage and limitation copy.

---

### Task 1: Share the tested browser document readers

**Files:**
- Create: `extension/document-readers.js`
- Modify: `src/connectors/chrome.mjs`
- Modify: `test/chrome-bridge.test.mjs`
- Test: `test/extension-document-readers.test.mjs`

**Interfaces:**
- Produces: `readThreadsIdentityDocument()`, `readThreadsPostsDocument()`, `readXIdentityDocument()`, `readXPostsDocument()`, and `readSurfaceDocument(surface)` as self-contained exported functions safe for both `page.evaluate()` and `chrome.scripting.executeScript({ func })`.
- Preserves: the existing exports from `src/connectors/chrome.mjs` so current callers do not change.

- [ ] **Step 1: Write the failing shared-reader test**

```js
import {
  readThreadsIdentityDocument,
  readXIdentityDocument,
  readSurfaceDocument,
} from '../extension/document-readers.js';

test('extension and Playwright use self-contained document readers', () => {
  assert.equal(typeof readThreadsIdentityDocument, 'function');
  assert.equal(typeof readXIdentityDocument, 'function');
  assert.equal(typeof readSurfaceDocument, 'function');
  assert.doesNotMatch(readSurfaceDocument.toString(), /require|process|window\.__/);
});
```

- [ ] **Step 2: Run the targeted test and observe the missing module**

Run: `node --test test/extension-document-readers.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `extension/document-readers.js`.

- [ ] **Step 3: Move, do not duplicate, the pure functions**

Create `extension/document-readers.js` with the five existing function bodies. In `src/connectors/chrome.mjs`, import and re-export them:

```js
import {
  readThreadsIdentityDocument,
  readThreadsPostsDocument,
  readXIdentityDocument,
  readXPostsDocument,
  readSurfaceDocument,
} from '../../extension/document-readers.js';

export {
  readThreadsIdentityDocument,
  readThreadsPostsDocument,
  readXIdentityDocument,
  readXPostsDocument,
  readSurfaceDocument,
};
```

- [ ] **Step 4: Run current bridge and new shared-reader tests**

Run: `node --test test/chrome-bridge.test.mjs test/extension-document-readers.test.mjs`

Expected: PASS with no changed extraction behavior.

- [ ] **Step 5: Commit the shared boundary**

Commit the three source/test files with a Lore message whose directive says all browser transports must use the shared readers.

---

### Task 2: Add extension connection state without duplicating Sources

**Files:**
- Modify: `src/db.mjs`
- Create: `src/extension-connections.mjs`
- Test: `test/extension-connections.test.mjs`

**Interfaces:**
- Produces: `connectExtension(db, registry, input) -> Promise<{ connection, account }>`.
- Produces: `getExtensionConnection(db, installationId, platform) -> { installationId, platform, account } | null`.
- Produces: `ingestExtensionBatch(db, config, input) -> Promise<ingest result>`.
- Input identity: `{ installationId: UUID, platform: 'x'|'threads', authenticatedIdentity: string, selectedCaptureKinds: string[] }`.

- [ ] **Step 1: Write failing connection and deduplication tests**

```js
const first = await connectExtension(db, registry, {
  installationId: '11111111-1111-4111-8111-111111111111',
  platform: 'x', authenticatedIdentity: 'reader_one', selectedCaptureKinds: ['save'],
});
const second = await connectExtension(db, registry, {
  installationId: '22222222-2222-4222-8222-222222222222',
  platform: 'x', authenticatedIdentity: 'reader_one', selectedCaptureKinds: ['save'],
});
assert.equal(first.account.id, second.account.id);
assert.notEqual(first.connection.installationId, second.connection.installationId);

await ingestExtensionBatch(db, config, {
  installationId: first.connection.installationId,
  platform: 'x', authenticatedIdentity: 'reader_one', kind: 'save', items: [item],
});
await ingestExtensionBatch(db, config, {
  installationId: second.connection.installationId,
  platform: 'x', authenticatedIdentity: 'reader_one', kind: 'save', items: [item],
});
assert.equal(searchSources(db).length, 1);
```

Also assert that an invalid UUID, changed handle, unselected capture kind, unsupported platform, and malformed canonical URL write zero rows.

- [ ] **Step 2: Run the targeted test and observe missing exports**

Run: `node --test test/extension-connections.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` or missing named exports.

- [ ] **Step 3: Add schema version 4**

Add this table to the fresh schema and update the expected schema version:

```sql
CREATE TABLE extension_connections (
  installation_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('x', 'threads')),
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_collected_at TEXT,
  PRIMARY KEY (installation_id, platform)
);
```

Keep the repository's existing no-migration policy: version 3 libraries fail without mutation and README continues to require a fresh version 4 library.

- [ ] **Step 4: Implement the minimum connection module**

Define two static connectors, `x-extension` and `threads-extension`, with `platform`, `capabilities: ['like','save','repost']`, and a request-local `verify()` that returns only the identity already extracted by the allowlisted extension. Call existing `connectAccount()` and `ingestCaptureBatch()` rather than writing parallel SQL.

Convert each extension item into the existing capture event shape:

```js
{
  externalId: item.postId,
  canonicalUrl: item.sourceUrl,
  author: { handle: item.authorHandle, name: item.authorName },
  text: item.text,
  sourceCreatedAt: item.postedAt,
  capture: { kind, nativeKind: kind, capturedAt: null },
  evidence: item.text ? [{ kind: 'text', text: item.text, sourceUrl: item.sourceUrl,
    provenance: 'chrome-extension-dom' }] : [],
  raw: { transport: 'chrome-extension' },
}
```

- [ ] **Step 5: Run the connection, ingestion, and legacy-schema tests**

Run: `node --test test/extension-connections.test.mjs test/platform-core.test.mjs test/ingest.test.mjs`

Expected: PASS; the legacy database test expects version 3 to be rejected unchanged.

- [ ] **Step 6: Commit the connection state**

Commit schema, module, and tests with a Lore message recording the intentional fresh-library boundary.

---

### Task 3: Implement and install the Native Messaging host

**Files:**
- Create: `src/extension-host.mjs`
- Create: `src/extension-host-installer.mjs`
- Modify: `src/cli.mjs`
- Modify: `src/bin.mjs`
- Test: `test/extension-host.test.mjs`
- Test: `test/extension-host-installer.test.mjs`
- Modify: `test/distribution.test.mjs`

**Interfaces:**
- Produces: `encodeNativeMessage(value) -> Buffer`.
- Produces: `createNativeMessageDecoder({ maxBytes }) -> { push(chunk): object[] }`.
- Produces: `handleExtensionRequest(context, request) -> Promise<response>`.
- Produces: `runNativeHost({ input, output, error, env }) -> Promise<void>`.
- Produces: `installExtensionHost({ platform, homeDir, extensionId, dataDir, nodePath, hostScriptPath }) -> Promise<{ manifestPath, hostName }>`.
- CLI: `social-memory extension install-host --extension-id <32 lowercase letters> [--json]`.

- [ ] **Step 1: Write failing protocol and trust-boundary tests**

```js
const decoder = createNativeMessageDecoder({ maxBytes: 1024 });
const encoded = encodeNativeMessage({ version: 1, id: 'a', method: 'health', params: {} });
assert.deepEqual(decoder.push(encoded.subarray(0, 3)), []);
assert.deepEqual(decoder.push(encoded.subarray(3)), [
  { version: 1, id: 'a', method: 'health', params: {} },
]);
assert.throws(() => decoder.push(Buffer.from([255, 255, 255, 127])), /too large/i);
```

Test request methods `health`, `connect`, `status`, and `ingest`; assert unknown methods and fields return a stable error without writing. Capture stdout and prove it contains only framed JSON while diagnostics use stderr.

- [ ] **Step 2: Run host tests and observe missing modules**

Run: `node --test test/extension-host.test.mjs test/extension-host-installer.test.mjs`

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement framing and request dispatch with Node stdlib**

Use `Buffer.readUInt32LE()` and `Buffer.writeUInt32LE()` because supported Chrome hosts use native little-endian on the target platforms. Set a conservative 2 MiB inbound application limit and 1 MiB outbound limit. Validate exact top-level keys `version`, `id`, `method`, and `params` before dispatch.

Responses use one shape:

```js
{ version: 1, id: request.id, ok: true, result }
{ version: 1, id: request.id, ok: false, error: { code, message } }
```

- [ ] **Step 4: Implement user-scoped macOS and Linux installation**

Validate extension IDs with `/^[a-p]{32}$/`. Write `com.ohmyjiro.social_memory.json` to:

- macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
- Linux: `~/.config/google-chrome/NativeMessagingHosts/`

The manifest contains an absolute private launcher path and exactly:

```json
{"type":"stdio","allowed_origins":["chrome-extension://<id>/"]}
```

Generate one mode-`0700` launcher that exports the validated absolute data directory and execs the absolute current Node binary with `src/extension-host.mjs`. Write the manifest mode `0600`; reject symlinks and unsafe existing files. Return `unsupported_platform` before filesystem writes on Windows.

- [ ] **Step 5: Wire CLI and direct host startup**

Add `--extension-id` parsing and the help line. Handle `extension install-host` before opening the database. In `src/bin.mjs`, keep normal CLI spawning unchanged; the generated launcher invokes `src/extension-host.mjs` directly.

- [ ] **Step 6: Run targeted and distribution tests**

Run: `node --test test/extension-host.test.mjs test/extension-host-installer.test.mjs test/distribution.test.mjs`

Expected: PASS and CLI help includes `extension install-host`.

- [ ] **Step 7: Commit the native bridge**

Commit host, installer, CLI wiring, and tests with a Lore directive that stdout is protocol-only and host origins are never wildcarded.

---

### Task 4: Build the Manifest V3 extension and multi-profile workflow

**Files:**
- Create: `extension/manifest.json`
- Create: `extension/service-worker.js`
- Create: `extension/popup.html`
- Create: `extension/popup.js`
- Create: `extension/popup.css`
- Test: `test/extension-ui.test.mjs`
- Test: `test/extension-service-worker.test.mjs`

**Interfaces:**
- Produces: `getInstallationId(storage) -> Promise<UUID>` using `crypto.randomUUID()` and `chrome.storage.local`.
- Produces: `nativeRequest(method, params) -> Promise<object>` using `chrome.runtime.connectNative('com.ohmyjiro.social_memory')`.
- Produces: `detectPlatform(tab) -> 'x'|'threads'|null`.
- Produces: `collectPlatform(platform, selectedCaptureKinds, limit = 100) -> Promise<summary>`.
- Popup messages: `get-state`, `connect`, `collect-now`, and `set-daily`.

- [ ] **Step 1: Write failing manifest and controller tests**

```js
const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url)));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions.sort(), ['alarms', 'nativeMessaging', 'scripting', 'storage']);
assert.deepEqual(manifest.host_permissions.sort(), [
  'https://*.threads.com/*', 'https://threads.com/*',
  'https://twitter.com/*', 'https://x.com/*',
].sort());
assert.equal(manifest.background.service_worker, 'service-worker.js');
```

With a fake `chrome` object, verify two separate storage instances create different installation IDs, `connect` sends the detected handle without typed identity, account mismatch prevents `ingest`, the alarm is recreated on startup, and only extension-created tabs are closed.

- [ ] **Step 2: Run the targeted extension tests and observe missing files**

Run: `node --test test/extension-ui.test.mjs test/extension-service-worker.test.mjs`

Expected: FAIL with missing manifest/modules.

- [ ] **Step 3: Create the least-privilege manifest and service worker**

Use a module service worker with top-level listeners:

```js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handlePopupMessage(message).then(sendResponse, error => sendResponse({ ok: false, error: error.message }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'social-memory-daily') void collectConnectedPlatforms();
});
chrome.runtime.onStartup.addListener(() => void ensureDailyAlarm());
chrome.runtime.onInstalled.addListener(() => void ensureDailyAlarm());
```

Do not request `cookies`, `history`, `downloads`, `tabs`, `<all_urls>`, or remote code.

- [ ] **Step 4: Implement bounded page collection**

For each selected kind, open or reuse the exact supported route, wait for tab completion, inject the shared identity/surface/post functions, scroll in bounded rounds, and send at most 100 normalized items per Native Messaging request. Re-check the handle immediately before each batch. Leave user-owned tabs open and close only tabs created by the extension.

- [ ] **Step 5: Implement the accessible popup**

Use native checkboxes and buttons. Show: host readiness, detected platform/handle, capture-kind choices, Connect, Collect now, once-daily toggle, last result, and concise remediation when the host is missing. Disable actions until at least one capture kind is selected. Persist settings by platform in `chrome.storage.local`.

- [ ] **Step 6: Run extension and shared-reader tests**

Run: `node --test test/extension-ui.test.mjs test/extension-service-worker.test.mjs test/extension-document-readers.test.mjs test/chrome-bridge.test.mjs`

Expected: PASS, including two-storage multi-profile behavior and fail-closed identity checks.

- [ ] **Step 7: Commit the installable extension**

Commit the extension and tests with a Lore message that records Chrome-running and alarm-delay limits.

---

### Task 5: Generate the guide image and document the real workflow

**Files:**
- Create: `assets/readme/social-memory-extension-guide.png`
- Modify: `README.md`
- Modify: `README.ko.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Produces: one privacy-safe 16:9 README image showing two fictional Chrome profiles flowing through one local bridge to one searchable library and Codex/Claude.
- Documents: unpacked installation, host installation, single-profile default, multi-profile connection, capture choices, manual collection, daily limitations, and CLI fallback.

- [ ] **Step 1: Generate the project-bound image with built-in image generation**

Use this prompt:

```text
Use case: infographic-diagram
Asset type: GitHub README workflow image, landscape 16:9
Primary request: Show two fictional Chrome profile windows, each with a compact Social Memory extension popup selecting Likes, Saves, and Reposts. Both flow through one secure local bridge into one searchable local library, then to Codex and Claude assistant windows.
Style/medium: polished flat product illustration, dark navy and warm violet accents, crisp UI cards, subtle depth
Composition/framing: left-to-right workflow, large readable shapes, generous spacing
Text (verbatim): "Chrome Profile A", "Chrome Profile B", "Social Memory", "Local Library", "Ask your AI"
Constraints: fictional handles only; no real screenshots; no passwords, tokens, logos, private data, or Chrome Web Store badge; accurate checkboxes; one post stored once
Avoid: tiny paragraphs, garbled text, photorealistic people, excessive gradients, watermarks
```

Move the selected generated file into `assets/readme/social-memory-extension-guide.png` and inspect it at original resolution.

- [ ] **Step 2: Add English and Korean quick starts around the image**

Place the image before `## Connect an account` / `## 계정 연결`. Lead with the extension path, then keep the current CLI Chrome flow under `Advanced: dedicated automation profile`. State that each extra Chrome profile needs one Connect click but no typed profile ID.

- [ ] **Step 3: Document honest scheduler and platform limits**

State that daily extension collection needs Chrome running, can be delayed, and does not wake sleeping devices. Keep macOS CLI scheduling as the unattended alternative and retain live X/Threads verification caveats.

- [ ] **Step 4: Update changelog**

Create `## 0.2.0 - Unreleased` above 0.1.0 and list extension, Native Messaging, multi-profile setup, source deduplication, and known macOS/Linux/unpacked boundaries.

- [ ] **Step 5: Verify image references and documentation commands**

Run: `rg -n "extension install-host|social-memory-extension-guide|Chrome Profile|하루 1회" README.md README.ko.md CHANGELOG.md`

Expected: both READMEs link the same existing asset and contain equivalent installation commands.

- [ ] **Step 6: Commit docs and generated asset**

Commit the image and documentation with the final built-in prompt recorded in the Lore body.

---

### Task 6: Package, verify, and release version 0.2.0

**Files:**
- Modify: `package.json`
- Modify: `scripts/release-check.mjs`
- Modify: `scripts/build-release-artifacts.mjs`
- Modify: `.github/workflows/release.yml`
- Modify: `test/distribution.test.mjs`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Package version: `0.2.0`.
- npm tarball includes `extension/` and the guide image.
- Release builder emits `social-memory-0.2.0.tgz`, `social-memory-extension-0.2.0.zip`, and `SHA256SUMS` containing basenames only.

- [ ] **Step 1: Write failing artifact assertions**

```js
assert.equal(packageJson.version, '0.2.0');
assert.ok(packageJson.files.includes('extension/'));
assert.ok(files.includes('package/extension/manifest.json'));
assert.ok(files.includes('package/assets/readme/social-memory-extension-guide.png'));
assert.equal(checksum.split('\n').filter(Boolean).length, 2);
assert.match(checksum, /social-memory-extension-0\.2\.0\.zip/);
```

- [ ] **Step 2: Run distribution tests and observe the old release shape**

Run: `node --test test/distribution.test.mjs`

Expected: FAIL on version, extension package, and ZIP checksum expectations.

- [ ] **Step 3: Update version, package allowlists, and artifact builder**

Add `extension/` to `package.json.files` and `allowedRoots`. Build the ZIP from only the extension directory using the system `zip` command after validating every included relative path. Add both artifact digests to basename-only `SHA256SUMS`.

- [ ] **Step 4: Update GitHub Release workflow**

Keep the tag trigger and existing verification. The existing `dist/*` upload includes both artifacts and the checksum file; no new action or dependency is needed.

- [ ] **Step 5: Run full verification**

Run independently:

```bash
npm test
npm run check
npm run skill:check
npm run release:check
SOCIAL_MEMORY_CHROME_TEST=1 node --test test/chrome-safety.test.mjs
```

Then load the unpacked extension in two temporary real Chrome profiles, run the local fixture flow, inspect the popup at original size, and confirm distinct installation IDs. Record live X/Threads as untested unless explicitly probed with the intended account profile.

- [ ] **Step 6: Finalize changelog and commit**

Change the 0.2.0 heading date to `2026-09-14` only after verification. Commit all release metadata with a Lore message listing the optional Chrome and live-account gaps honestly.

- [ ] **Step 7: Push main and verify CI**

Push `main`, wait for Linux/macOS × Node 22.16/24 CI, and stop on any failure.

- [ ] **Step 8: Tag and verify public artifacts**

Create annotated tag `v0.2.0`, push it, wait for the Release workflow, download all assets into a fresh temporary directory, run `shasum -a 256 -c SHA256SUMS`, and verify the tarball and ZIP contain `LICENSE.md` and `manifest.json` respectively.
