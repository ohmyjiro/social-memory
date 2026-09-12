# Social Memory Release Candidate Plan

## Goal

Raise Social Memory from a fixture-only core to an installable release candidate that another macOS user can unpack, diagnose, configure, schedule, and connect to Codex or Claude Code, while preserving exact evidence and capture provenance.

## Release definition

“Deployable” means all of the following are true:

1. a clean machine with Node.js 22.16+ can install the packed artifact without repository-only files;
2. `--help`, `--version`, `doctor`, initialization, upgrade, backup, and restore paths are documented and tested;
3. real user data can enter through a generic import connector without editing code;
4. the X connector supports official user-context reads for `like`, `save`, and `repost`, with credentials supplied by environment or OS credential provider and never persisted in the library;
5. the Threads connector uses an explicit isolated-browser bridge because the official API does not expose a verified liked/saved retrieval contract;
6. account identity is verified exactly before any collection, and capture-kind cursors remain independent;
7. a scheduler can be installed only after a successful manual sync for the same account and selected kinds;
8. a distributable Agent Skill and read-only MCP configuration are generated with resolved absolute paths;
9. CI, security guidance, contribution guidance, changelog, license, package contents, and release checks are complete;
10. fixture, import, connector-contract, package-install, scheduler, MCP, and bounded live probes all have explicit evidence.

The release is not complete if only fixture tests pass. Live X and Threads probes must report the authenticated identity, requested capture kind, item count, and cursor behavior without exposing secrets or private item bodies.

## Architecture decision

- Keep the zero-dependency core.
- Use Node's built-in `fetch` for the official X API connector.
- Inject credential and HTTP providers so tests remain offline and secrets never enter fixtures.
- Treat Threads browser automation as a companion bridge implementing the same connector contract, not as core scraping logic.
- Ship a generic JSON import connector so the product remains useful when a platform connector is unavailable.
- Generate scheduler and agent configuration from the CLI; do not make users hand-edit absolute paths.

## Evidence from current platform contracts

- X officially documents separate authenticated-user endpoints for liked posts and bookmarks. Bookmark reads require OAuth user context and `bookmark.read`; liked-post reads use the liked-posts endpoint.
- The currently available official Meta Threads collection documents authorization, publishing, replies, and insights, but no liked/saved retrieval endpoint was found. Therefore a Threads API adapter must not pretend those surfaces exist.

## Work packages

### 1. Distribution shell

- Add tested `--help`, `--version`, and `doctor` commands.
- Add deterministic exit codes and suppress experimental SQLite warnings in the installed executable.
- Define an npm package allowlist and prove `npm pack` contains no private or runtime data.
- Add migration metadata so upgrades can be performed safely.

### 2. Generic import

- Define a versioned JSON capture export schema.
- Add `social-memory import --file ... --connector ... --account ...`.
- Preserve `like`, `save`, and `repost` exactly and reject malformed files transactionally.
- Support referenced local Evidence files only from an explicitly selected import root.

### 3. Official X connector

- Resolve user ID through `/2/users/me` and verify the configured handle.
- Collect likes through `/2/users/:id/liked_tweets`.
- Collect saves through `/2/users/:id/bookmarks`.
- Collect reposts through the authenticated user's post timeline and retain the referenced source.
- Handle pagination, rate limits, API errors, and connector drift with safe codes.
- Accept tokens from an injected credential provider; provide environment and macOS Keychain providers without storing token values.

### 4. Threads isolated-browser bridge

- Define a local NDJSON request/response protocol for verify and per-kind collection.
- Require one profile reference per account and exact authenticated-handle proof.
- Provide DOM snapshot contracts and parsers for liked, saved, and repost surfaces.
- Keep navigation/extraction in the companion browser process so core remains testable.
- Validate with synthetic HTML first, then bounded Aside profile probes per capture kind.

### 5. Operations and agent integration

- Add manual-sync success receipts.
- Generate a macOS LaunchAgent only when the receipt covers every currently selected stream.
- Add status, uninstall, logs, backup, restore, and schema-upgrade commands.
- Ship a Codex/Claude Code Skill and generate MCP configuration with absolute executable/data paths.

### 6. Release governance and proof

- Add CI for Node 22 and current Node LTS on macOS and Linux where supported.
- Add `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, and the user-selected license.
- Run package extraction/install from a path containing spaces.
- Scan the package and full Git history for credentials, private handles, home paths, databases, browser data, and personal captures.
- Run bounded live X and Threads probes without persisting secrets.
- Tag only after every required gate passes.

## Risk gates

- License selection is required before public publication.
- X API access may carry pay-per-use cost and requires a developer app; failure to have access is a connector availability state, not a product success.
- Threads DOM automation can drift and must fail closed as `connector_drift`, never as a successful empty sync.
- Scheduling before a successful manual live sync is prohibited.
- The remote ChatGPT bridge remains outside this release unless its authentication, transport, and exposure model receive a separate security review.

## Verification matrix

| Requirement | Proof |
| --- | --- |
| Installable artifact | `npm pack`, unpack, `npm install -g`, CLI smoke in path with spaces |
| Safe upgrade | migration tests from every released schema fixture |
| Capture distinction | fixture/import/X/Threads contract tests for shared Source + distinct Captures |
| Credential safety | package/history scan and injected fake credential tests |
| Account safety | exact configured/authenticated identity tests and bounded live evidence |
| Automation | manual-sync receipt gate plus LaunchAgent integration test |
| Agent use | generated Skill validation and MCP initialize/tools/call smoke |
| Release readiness | clean Git tree, CI green, license present, changelog and signed artifact checksums |
