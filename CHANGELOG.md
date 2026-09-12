# Changelog

All notable changes to Social Memory will be documented here.

## 0.1.0 - Unreleased

- Added the local SQLite Source, Capture, and Evidence model.
- Preserved likes, saves, reposts, and manual imports as distinct signals.
- Added content-addressed file evidence, lexical search, CLI, and read-only MCP.
- Added an offline fixture connector for installation verification.
- Added a versioned JSON import path with confined Evidence file references.
- Added an official X API connector contract for separate likes, bookmarks, and reposts.
- Kept X credential values outside the library by storing only environment-variable references.
- Added an Aside-backed Threads connector with exact profile identity checks and fail-closed UI landmarks.
- Kept Threads likes, saved posts, and reposts on separate collection surfaces and cursors.
- Added manual-sync receipts and gated macOS LaunchAgent scheduling.
- Added macOS Keychain references for unattended X authentication.
- Added integrity-checked backup and non-overwriting restore workflows.
- Added validated Social Memory Skill packaging and Codex/Claude Code MCP scaffolds.
- Made failed or empty sync invocations return a non-zero process status.
- Preserved the install-time executable search path for scheduled browser connectors.
- Rejected backup destinations nested inside the live library.
- Added an optional Aside-backed X connector for users without developer API access.
- Live-probed X and Threads likes, saves, and reposts in isolated temporary libraries.
- Hardened Evidence publication against source-file races and streamed large-file hashes.
- Rejected symbolic-link database/config targets and preserved loaded agents when unload fails.
- Added conditional `doctor` diagnostics for the Aside CLI when a browser-backed connector is configured.
- Added portable GitHub Release artifacts with basename-only SHA-256 manifests.
- Extended packed-artifact verification through generated Codex setup and installed stdio MCP discovery.
- Made macOS-only scheduler operations fail before filesystem or process access on unsupported platforms.
