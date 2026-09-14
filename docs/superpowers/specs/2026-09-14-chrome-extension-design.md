# Social Memory Chrome Extension Design

Date: 2026-09-14
Status: approved direction, awaiting implementation-plan review

## Goal

Make the common path one Chrome extension click instead of asking a user to create or name automation profiles. The extension uses the social accounts already signed into the current Chrome profile, lets the user choose likes, saves, and reposts independently, and writes normalized captures into the existing local Social Memory library.

This design keeps the current CLI Chrome connectors for unattended and advanced operation. It adds a second transport; it does not create another database or interpretation layer.

## User experience

### First Chrome profile

1. Install the Social Memory CLI and initialize a local library.
2. Load the unpacked extension from the release, then copy its ID from `chrome://extensions`.
3. Run `social-memory extension install-host --extension-id <id>` once. The command installs a user-scoped Native Messaging host bound to that extension ID and current library.
4. Open X or Threads in the same Chrome profile and sign in normally.
5. Open the Social Memory extension, select `Likes`, `Bookmarks / Saves`, and/or `Reposts`, then press **Connect**.
6. Press **Collect now**, or enable the once-daily Chrome alarm.

The popup shows the handle detected from the current site. It never asks the user to type an account handle or a profile ID.

### Additional Chrome profiles

Enable the extension in each Chrome profile and press **Connect** once. The extension stores an opaque installation ID in `chrome.storage.local`; the native host stores that transport identity together with the verified platform and handle. Users never name profiles manually.

The handle remains the canonical social identity. The extension installation ID only distinguishes browser transports. A post received through multiple profiles or connectors is one Source keyed by platform and external post ID; account and capture-kind provenance remain separate Capture records.

Chrome's public Storage documentation does not explicitly promise isolation between ordinary Chrome profiles. The implementation therefore must verify this behavior in two real temporary profiles and must never trust the installation ID as account identity.

## Scope

### Version 0.2 extension

- Manifest V3 extension for `x.com`, `twitter.com`, and `threads.com`.
- Popup for connection status, platform, detected handle, selected capture kinds, manual collection, and once-daily collection.
- User-scoped Native Messaging host installation on macOS and Linux.
- Current-page identity verification and supported collection-page extraction.
- Direct ingestion into the existing Source / Capture / Evidence model.
- English and Korean README instructions plus one generated, fictional workflow image.
- Release archive containing a separately loadable extension directory.

### Deliberately deferred

- Chrome Web Store publication. Unpacked installation proves the product path first.
- Windows Native Messaging host installation. Windows needs a packaged executable or separately verified launcher; the existing CLI remains Windows-unverified.
- Exact-time guarantees. Chrome alarms may be delayed and do not wake a sleeping device.
- Continuous background crawling while Chrome is closed.
- Automatic media downloading, OCR, PDF extraction, or transcription.
- Firefox, Safari, and Edge store packaging.

## Architecture

```text
Chrome profile
  popup
    -> service worker
       -> chrome.scripting in X / Threads tab
       -> chrome.runtime.connectNative
          -> com.ohmyjiro.social_memory host
             -> existing account validation
             -> existing ingestion and deduplication
             -> local SQLite + Evidence files
```

### Extension

`extension/manifest.json` requests only `nativeMessaging`, `storage`, `alarms`, `scripting`, and the supported host permissions. It does not request cookies, browsing history, downloads, or access to unrelated sites.

The popup sends commands to a top-level service-worker listener. Content extraction runs in Chrome's isolated world through `chrome.scripting.executeScript`; the service worker owns Native Messaging because content scripts cannot call it directly.

All durable extension state lives in `chrome.storage.local`. Global service-worker variables are caches only because Manifest V3 workers are ephemeral. Alarm listeners are registered synchronously at module top level, and startup rechecks that the daily alarm exists.

### Shared document extraction

The X and Threads DOM readers currently embedded in `src/connectors/chrome.mjs` move into one browser-safe module. Both Playwright Chrome connectors and the extension import the same pure extractors, preventing two drifting interpretations of account identity and posts.

The extractors return data only when all of these agree:

- supported origin and exact collection route;
- authenticated handle landmark;
- selected collection heading;
- canonical post permalink;
- configured handle equals the handle observed at collection time.

UI drift, redirection, missing identity, and account changes fail before ingestion.

### Native host

The host name is `com.ohmyjiro.social_memory`. It uses Chrome's length-prefixed UTF-8 JSON protocol over stdin/stdout. Protocol output is the only stdout content; diagnostics go to stderr.

`social-memory extension install-host --extension-id <id>` writes a user-scoped host manifest with one exact `allowed_origins` entry and a private launcher/config that fixes the absolute Social Memory data directory. It refuses wildcard origins, malformed extension IDs, relative data paths, symlinks, and unsafe existing files.

Supported requests are versioned and allowlisted:

- `health`: confirm host and library readiness;
- `connect`: verify and register one platform account plus selected capture kinds;
- `ingest`: validate the connected account and ingest one bounded batch;
- `status`: return only this extension installation's connection and last-run state.

Unknown fields, oversized messages, unsupported platforms, invalid URLs, invalid capture kinds, and mismatched handles are rejected without database writes. No request may provide a database path, filesystem destination, executable, cookie, password, or token.

## Collection behavior

The user selects any combination of `like`, `save`, and `repost`. Selection is OR-based eligibility: a post matching any selected kind is collected. One qualifying post produces one Source even when it matches several kinds; distinct Capture records preserve why and from which account it was collected.

**Collect now** opens or reuses one inactive supported collection tab at a time, waits for explicit identity and surface landmarks, scans a bounded number of posts using the existing cursor rules, sends the normalized batch to the host, and closes only tabs created by the extension.

The daily alarm repeats the same bounded operation while Chrome is running. Missed or delayed alarms are reported as such; the popup never claims an exact collection time. The existing CLI scheduler remains the documented choice for unattended macOS collection.

## Multi-profile rules

- One Chrome profile may connect one X handle and one Threads handle.
- A second Chrome profile receives a different local installation ID and may connect different handles.
- The native host is shared at the operating-system user level but scopes status and connection records by installation ID.
- Every collection re-verifies the live handle; installation ID alone grants no identity authority.
- Incognito collection is disabled in version 0.2 because Chrome documents that extension local storage is shared between regular and incognito processes.
- Removing or reconnecting one Chrome profile does not delete historical Sources or Captures.

## Visual and documentation

Generate `assets/readme/social-memory-extension-guide.png` as a fictional, privacy-safe product illustration. It shows two Chrome profiles, each with a small Social Memory popup, flowing through one local bridge into one searchable library and then Codex / Claude. Use short English UI labels only; do not show real handles, browser screenshots, credentials, or claims of Chrome Web Store availability.

Place the image immediately before the new extension quick-start section in both README files. English remains the default README; Korean carries equivalent instructions. Both documents must separate implemented behavior from limitations and label unpacked installation clearly.

## Packaging and release

`extension/` is included in npm and GitHub release artifacts. The release check verifies the manifest allowlist, absence of remote executable code, absence of secrets/private paths, and presence of the extension guide image.

The first implementation release increments the package to `0.2.0` because it adds a new user-facing connector transport. The GitHub tag workflow publishes the CLI tarball, checksum, and an extension ZIP. npm publication remains out of scope until registry authentication exists.

## Verification

Automated checks:

- native-message frame encoding and decoding, including partial reads and size limits;
- host manifest path and permissions on macOS and Linux;
- rejection of wildcard/malformed extension origins and unsafe files;
- connect and ingest validation, rollback, account mismatch, and cross-connector Source deduplication;
- popup/service-worker message schema and capture-kind selection;
- shared X/Threads extractors against existing local HTML fixtures;
- package and release artifacts contain the license, extension, guide image, and no private data.

Manual checks using fictional/local fixtures:

- load unpacked extension in two temporary Chrome profiles;
- confirm distinct installation IDs and account mappings;
- connect X and Threads fixture pages without typed handles;
- collect one post matching both like and save and see one search result with two provenance records;
- disconnect one profile and confirm history remains;
- inspect popup at narrow width and with keyboard navigation.

Live-account verification remains a separate, explicit check. Passing fixture or DOM tests must not be described as proof that current X or Threads pages work.

## Official Chrome constraints used

- Native Messaging: <https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging>
- Stable development extension ID: <https://developer.chrome.com/docs/extensions/reference/manifest/key>
- Storage: <https://developer.chrome.com/docs/extensions/reference/api/storage>
- Alarms: <https://developer.chrome.com/docs/extensions/reference/api/alarms>
- Script injection: <https://developer.chrome.com/docs/extensions/reference/api/scripting>
- Service-worker lifecycle: <https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle>
