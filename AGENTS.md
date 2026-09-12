# Social Memory contributor rules

- Keep runtime data and real account content outside this repository.
- Never commit passwords, cookies, tokens, OTPs, browser profiles, or private collected material.
- Preserve `like`, `save`, `repost`, and `manual` as distinct canonical capture kinds.
- Require explicit account capture selection; reconfiguration must not delete historical captures.
- Scope every cursor to one account and one capture kind.
- Keep MCP read-only. Collection and account mutation belong to the CLI/service boundary.
- Add a failing behavior test before changing production behavior.
- Use only fictional fixture identities and `example.test` URLs in tests.
- Do not claim live X/Threads support from fixture or local-only test results.
- Use Lore-format Git commit messages and report untested boundaries honestly.
