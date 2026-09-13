# Product Marketing Context

**Document version:** v1
**Last updated:** 2026-09-13

## Product overview
Social Memory turns saved social material into a local, searchable evidence library for an existing agentic assistant. CLI product; SQLite/FTS5, normalized connectors, read-only MCP. Business model and license remain undecided; package is UNLICENSED.

## Audience and jobs
Independent developers, creators, and researchers who save posts and already use Codex or Claude Code. Retrieve implementation notes, compare interests across capture types, and develop ideas with source evidence. B2B buying personas are not applicable to this preview.

## Problem and switching dynamics
Push: saved material is difficult to find again. Pull: one searchable local archive with source context.
Habit: continuing to use platform bookmarks. Anxiety: setup friction, login isolation, and collection reliability.
Cost: terminal setup, dedicated logins, and ongoing connector maintenance. No measured time savings claimed.

## Alternatives and differentiation
Alternative approaches include native bookmarks, read-later apps, and general knowledge bases. No named competitor comparison has been researched.
Product emphasis: separate likes/saves/reposts, local source evidence, interchangeable collection routes, and retrieval through the assistant already in use. These are positioning choices, not claims of exclusive capability or superiority.

## Objections and fit
- Does it require another LLM API bill? No Social Memory LLM key; assistant limits and source API charges remain.
- Is everything offline? Storage is local; the connected assistant may transmit retrieved evidence.
- Is collection fully reliable? No. Chrome live account coverage is unverified and UI pagination is heuristic.
Not a fit yet: GUI-only users, guaranteed exhaustive archives, or direct hosted ChatGPT integrations.

## Customer language
Use: saved posts, find it again, source evidence, likes versus bookmarks, your existing assistant.
Avoid: perfect memory, fully automatic understanding, unlimited free AI, all platforms supported.
Source means the original item; Capture records the reaction; Evidence holds supporting material.

## Brand voice and story
Clear, practical, warm, source-grounded. The user is the protagonist.
Desire: reuse a saved idea. Obstacle: cannot find the post. Choice: connect a local library.
Scene: ask an assistant for a relevant implementation note and follow its source.
No invented customer story, testimonial, causal performance claim, or urgency.

## Proof and limitations
Repository code supports CLI, SQLite/FTS5, evidence storage, backup, agent scaffolding, and macOS scheduling. Recent local run: 81 passing tests with optional Chrome DOM tests enabled. No customer or revenue metrics. Live Chrome collection, Windows end-to-end operation, full media extraction, and public licensing remain open.

## Goal
Primary reader action: run the synthetic local demo, then configure a dedicated account.
English README is default; Korean README has equivalent claims and operational boundaries.
Diagrams are conceptual SVGs, not product screenshots.

## Changelog
- v1 (2026-09-13) — Established evidence-backed positioning for bilingual illustrated READMEs.
