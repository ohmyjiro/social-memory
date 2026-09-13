# Social Memory

**Your X (Twitter) bookmarks and Threads saves. Ready for your next idea.**

[English](README.md) · [한국어](README.ko.md)

Collect the posts you like, bookmark, and repost on **X (Twitter) and Threads** into a searchable local library. Then ask **Codex or Claude Code** to find implementation notes, compare marketing ideas, or help shape your next project—with links back to the originals.

![Social Memory: selected social signals flow into a local library; a connected AI assistant retrieves evidence and produces answers.](assets/readme/workflow.en.svg)

> **Development preview.** Local CLI + SQLite + read-only MCP. Chrome collection is implemented and tested against local HTML, but live account collection is not yet verified. Licensing terms are under review; the package remains `UNLICENSED`.

[Try the local demo](#try-the-local-demo) · [Connect an account](#connect-an-account) · [Ask your assistant](#ask-your-assistant) · [Current limits](#current-limits)

## What can you collect?

| Where you save | Choose the signals | What you can ask later |
| --- | --- | --- |
| **X (Twitter)** | Likes · bookmarks · reposts | “Find the API implementation tips I bookmarked.” |
| **Threads** | Likes · saved posts · reposts | “Compare the marketing ideas I saved last week.” |
| **Your JSON exports** | Imported posts and supporting files | “Find references relevant to this project.” |

You decide which signals to collect for each account. Liking something and bookmarking it are separate choices—and stay separate in the library.

## See the everyday workflow


1. **Save as usual.** Bookmark an implementation tip on X. Save a marketing example on Threads.
2. **Collect on your Mac.** After initial login and a successful trial sync, configure a collection interval. The local library retains what the connector retrieves.
3. **Ask where you work.** In your connected Codex or Claude Code session, ask: “Find useful ideas from last week’s X bookmarks and Threads saves for my new app. Cite the sources.”
4. **Go back to the evidence.** Open the original links, compare approaches, and ask the assistant to turn the findings into an experiment or implementation plan.

This is an **illustrative workflow**, not a recorded live demo. Results depend on the material collected; Chrome live-account coverage still needs verification.

| Your task | Example prompt |
| --- | --- |
| Build an app | “Find implementation methods in my X bookmarks relevant to this feature.” |
| Plan marketing | “Group last week’s Threads saves by marketing approach and show the original posts.” |
| Write a story | “Find narrative devices in my saved posts. Label any new premise as AI synthesis.” |
| Review your interests | “How do the topics I like differ from the ones I bookmark?” |

## You saved it for a reason

An implementation trick. A pricing example. A story premise. You saved the post—but when you need it, you have to remember where it was.

Social Memory keeps the source, how you saved it, and its supporting evidence together. A connected assistant can search that library and help you make something from it.

Example requests after connecting your assistant:

> “Find saved posts about onboarding and suggest three experiments. Link the sources.”
>
> “Compare what I liked with what I bookmarked last month.”
>
> “Find implementation notes relevant to this feature.”

These are example prompts, not sample results or built-in automatic reports.

## Keep the context, not just the link

- **Preserve your intent.** Likes, bookmarks, reposts, and manual imports stay separate.
- **Keep a local library.** SQLite stores sources and capture history; file evidence is stored by content hash.
- **Use your existing assistant.** Codex or Claude Code retrieves evidence through read-only MCP. The assistant handles grouping, summaries, and synthesis.
- **Choose your connector.** System Chrome, optional Aside, the X API, or a versioned JSON import.
- **Trace an idea back.** Source URLs, authors, capture types, and available evidence remain accessible.

The archive stays local. Evidence returned to a cloud-connected assistant can leave your machine under that assistant’s settings. Social Memory does not require its own LLM API key; your assistant’s usage limits and any source API charges still apply.

![One source can have separate like and bookmark capture records, with supporting text or files.](assets/readme/evidence.en.svg)

A post you both like and bookmark is one source with two capture records **within the same connector**. Disabling bookmark collection later does not delete previous records. Using multiple connectors for the same platform can create duplicate sources.

## Try the local demo

Requires **Node.js 22.16+**. These commands use a macOS/Linux shell. Start from a local source checkout; a public npm release is not assumed.

```bash
cd /path/to/social-memory
npm install --ignore-scripts
npm install --global .
social-memory --version

# Keep demo data outside the source checkout.
export SOCIAL_MEMORY_DATA_DIR="$HOME/social-memory-demo"
social-memory init --data-dir "$SOCIAL_MEMORY_DATA_DIR" --json

social-memory connector configure fixture \
  --account fictional_reader --include like,save --json
social-memory sync --json
social-memory search "fixture" --kind save --json
```

The fixture uses synthetic data and needs no SNS login. To run without a global install, replace `social-memory` with `node /absolute/path/to/social-memory/src/cli.mjs`.

Choose a **different directory** for real data so the fixture does not mix with your archive:

```bash
export SOCIAL_MEMORY_DATA_DIR="$HOME/social-memory-data"
social-memory init --data-dir "$SOCIAL_MEMORY_DATA_DIR" --json
```

Set this environment variable again in each new terminal, or put it in your shell configuration. Use the same absolute directory in your assistant’s MCP configuration.

## Connect an account

Install Google Chrome first. Social Memory uses `playwright-core` to launch it; no separate browser download is needed.

### Threads with Chrome

```bash
# Choose a new profile name. Log in in the opened window, then close it.
social-memory browser open \
  --profile-ref threads-reader --url https://www.threads.com/

# Replace reader_handle with the exact handle you logged into.
social-memory connector configure threads-chrome \
  --account reader_handle --profile-ref threads-reader \
  --include like,save,repost --json

# Begin with a small collection.
social-memory sync --connector threads-chrome --kind save --limit 3 --json
```

`threads-reader` is a name you choose—not an ID you obtain elsewhere. Each account needs its own profile. Chrome stores it under `SOCIAL_MEMORY_DATA_DIR/chrome-profiles/`; your everyday Chrome profile is not reused.

### X with Chrome

```bash
social-memory browser open --profile-ref x-reader --url https://x.com/home
social-memory connector configure x-chrome \
  --account reader_handle --profile-ref x-reader \
  --include like,save,repost --json
social-memory sync --connector x-chrome --kind save --limit 3 --json
```

Select only what you want: `like`, `save`, `repost`. Check the configured and authenticated identities with `social-memory connector status --json`. Browser collection rejects account mismatches and missing supported page markers.

### Other connectors

| Connector | Needs | Status |
| --- | --- | --- |
| `threads-chrome`, `x-chrome` | Installed Chrome + isolated login | Offline DOM tests; live collection unverified |
| `threads`, `x-aside` | Aside CLI + dedicated Aside account ID | Prior small live probes; ongoing coverage not guaranteed |
| `x` | Authorized user OAuth token | API contract tested offline; live probe pending |
| `import` | JSON export | Local import tests |
| `fixture` | Nothing external | Synthetic installation demo |

For Aside, run `aside account list` and use the intended account ID (for example, `u1`) as `--profile-ref`. Verify which SNS account is logged into it. Use `threads` or `x-aside` in `connector configure`; these existing IDs continue to select Aside.

For the X API, make a user OAuth token available securely through an environment variable, then configure its **name**, not its value:

```bash
social-memory connector configure x \
  --account reader_handle --include like,save \
  --credential-env SOCIAL_MEMORY_X_ACCESS_TOKEN --json
```

Scheduled X API collection requires a macOS Keychain reference:
`--keychain-service social-memory.x --keychain-user reader_handle`.
Create that credential securely beforehand. Verify current X permissions and API charges separately.

## Ask your assistant

Generate the integration files:

```bash
social-memory agent scaffold \
  --client codex --output "$HOME/social-memory-codex-setup" --json
```

Use `--client claude` for Claude Code. Follow the generated `INSTALL.md` to install the skill and merge the MCP configuration; **generating files does not activate the integration**.

| MCP tool | What your assistant can do |
| --- | --- |
| `search_sources` | Search text and filter by connector, account, capture type, and date |
| `get_source` | Read a source with its capture records and evidence |
| `list_capture_kinds` | Inspect the available capture types |
| `get_health` | Inspect library counts and state |

The current search engine is **SQLite FTS5 keyword search**, not embedding-based semantic search. Your assistant can translate a question into multiple searches and synthesize the results. Ask it to distinguish source facts from new AI-generated ideas.

Ordinary ChatGPT web chats do not automatically access this local stdio MCP server. A hosted bridge and automatic delivery of daily reports into ChatGPT are not implemented.

## Collect on a schedule

On macOS, first complete a manual sync for **every selected account × capture type**:

```bash
social-memory sync --json
social-memory schedule readiness --json
social-memory schedule install --interval-minutes 1440 --json
social-memory schedule status --json
```

This requests a 24-hour interval, not a fixed wall-clock time. The Mac must be available to run the task; sleep, logout, and expired logins can interrupt collection. Remove the schedule with `social-memory schedule uninstall --json`.

Scheduling collects sources. Summaries are produced by the connected assistant when requested, unless you separately configure an assistant workflow.

## Import, search, and back up

```bash
social-memory import --file /absolute/path/to/export.json \
  --account my_archive --include like,save --json
social-memory search "pricing" --kind save --json
social-memory source SOURCE_ID --json
social-memory health --json
social-memory doctor --json

social-memory backup create --output "$HOME/social-memory-backup" --json
social-memory backup restore --from "$HOME/social-memory-backup" \
  --data-dir "$HOME/social-memory-restored" --json
social-memory upgrade --json
```

See the [import schema](schemas/capture-export-v1.schema.json) and [synthetic example](examples/import.v1.json). Imported evidence files must be relative to, and contained beneath, the export’s directory. Backups verify hashes; restore creates a new directory rather than overwriting an existing library. Browser sessions are excluded—log in again after moving machines.

## Current limits

- **Platforms:** macOS is the primary tested host; Linux is in core CI coverage. Windows CLI initialization was corrected, but Windows end-to-end operation is unverified. Scheduling is macOS-only.
- **Browser changes:** Chrome requires supported Korean/English headings and page structure. X/Threads can change these. A successful local test does not prove a live account works.
- **Coverage:** Chrome resumes using a post ID. Missing anchors fail explicitly. End-of-list detection is heuristic; complete history is not guaranteed. New posts are revisited after the current history pass ends.
- **Media:** Imported files can be preserved. Browser connectors currently record available media metadata/links; full automatic media downloading, OCR, PDF text extraction, and video transcription are not implemented.
- **Interface:** CLI and agent integration. No desktop GUI, setup wizard, hosted service, or Naver Blog connector.

## Development and license

```bash
npm test
npm run check
npm run skill:check
npm run package:check
# Optional: installed Chrome, local HTML only.
SOCIAL_MEMORY_CHROME_TEST=1 node --test test/chrome-safety.test.mjs
```

The latest local verification passed 81 tests including the opt-in Chrome DOM tests. This is test evidence, not a live-service availability claim.

The core keeps **Source / Capture / Evidence** separate; connectors provide normalized records; the assistant owns interpretation. Review [security boundaries](SECURITY.md) and the [changelog](CHANGELOG.md) before changing collection behavior. Keep real account data, profiles, and credentials outside the repository.

**License pending: `UNLICENSED`.** Public release is blocked until a license is chosen. `npm run release:check` enforces that gate; `package:check` only checks the development artifact. Do not assume public GitHub Release or npm artifacts are available.
