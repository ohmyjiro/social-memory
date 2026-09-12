# Security

## Supported versions

Until the first stable release, security fixes are provided only for the latest commit on the default branch.

## Reporting a vulnerability

Do not open a public issue containing credentials, private social content, browser data, or an exploitable security report. Use the repository's private GitHub Security Advisory flow after the repository is published. If that channel is unavailable, report only that a private contact channel is needed; do not paste the sensitive details into a public issue.

## Trust boundaries

- Social Memory stores its SQLite database and Evidence under the absolute directory chosen by the user.
- X token values come from an environment variable or macOS Keychain and are not written to the database.
- Threads access stays inside an explicitly named Aside profile. The configured and authenticated handles must match before collection.
- MCP tools are read-only. Account configuration, collection, scheduling, backup, and restore remain CLI-only operations.
- Backups contain private source content. Store and transmit them as sensitive personal data.
- Database/config symbolic links are rejected, and content-addressed Evidence is copied to a private staging file before it is hashed and published.

Before publishing a release, run `npm run release:check` and review the packed file list. The prepublish hook blocks an unlicensed package. This check is a guardrail, not proof that a connector or browser profile is safe.
