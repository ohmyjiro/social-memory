# Changelog

All notable changes to Social Memory will be documented here.

## 0.1.0 - 2026-09-14

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
- Added isolated system-Chrome profiles and Chrome-backed X/Threads connectors while keeping Aside optional.
- Rejected dot and symlink Chrome profile targets; revalidated account, final route, and visible collection headings during collection.
- Added bounded loading retries and post-ID resume cursors, with explicit failure when the resume anchor disappears.
- Removed the POSIX user-ID requirement from general CLI initialization; scheduling remains macOS-only.
- Added real-Chrome offline DOM regression tests and clarified unverified live-collection boundaries.
- Made the normal Chrome setup path discover the signed-in handle and use one default profile per platform.
- Kept explicit profile names as an optional multi-account path instead of a single-account requirement.
- Deduplicated sources by platform and external post ID across Chrome, Aside, API, and declared extension routes.
- Rejected legacy libraries without conversion and removed the misleading upgrade command.
- Released the source under the PolyForm Perimeter License 1.0.1.
