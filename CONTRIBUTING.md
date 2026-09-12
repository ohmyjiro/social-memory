# Contributing

Social Memory is local-first. Contributions must preserve three invariants:

1. `like`, `save`, `repost`, and `manual` remain distinct capture signals.
2. Account-scoped collection verifies the authenticated identity before reading content.
3. Secrets, cookies, browser profiles, private databases, and real capture bodies never enter fixtures or Git history.

Use synthetic fixtures and injected browser, HTTP, credential, clock, and process boundaries. A passing offline test must not be described as a live connector success.

Before submitting a change:

```bash
npm test
npm run check
npm run skill:check
npm run package:check
```

`npm run release:check` is the stricter publication gate. It intentionally fails while the package is `UNLICENSED`.

Keep changes focused and document connector failure modes. UI-backed connectors must fail closed when their required landmarks disappear; they must not turn drift into a successful empty collection.
