---
name: social-memory
description: Search and inspect a user's local Social Memory evidence library when they ask about previously liked, saved, reposted, or imported social material. Use it for retrieval and evidence-backed synthesis, not for collecting or modifying accounts.
---

# Social Memory

Use the Social Memory MCP tools to retrieve source material before answering questions about the user's social archive.

- Start with `search_sources`. Translate conversational time, platform, account, and reaction constraints into its filters when available.
- Treat `like` and `save` as different signals. Do not merge them unless the user asks for a combined view.
- Call `get_source` for the strongest candidates before making detailed claims. Use its Captures to explain why the item is present and its Evidence to ground the answer.
- Distinguish retrieved source content from your interpretation, categorization, or new ideas. Label synthesis when it is not stated in the source.
- If retrieval is thin, broaden the query deliberately and say what changed. Do not invent missing source text or provenance.
- The MCP surface is read-only. Account setup, synchronization, scheduling, and deletion are outside this skill; explain that they require the local `social-memory` CLI.
