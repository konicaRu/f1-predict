# Telegram dossier formats implementation plan

> **For agentic workers:** use superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Ship the approved two formats and schedule the one-time group demonstration.
**Architecture:** Extend existing JS builders and transport. Source-tagged historical facts are shared by both layouts. A separate date-guarded workflow runs an at-most-once showcase.
**Tech Stack:** Node.js, Playwright, Telegram Bot API, existing Postgres job_runs, GitHub Actions.
**Spec:** docs/superpowers/specs/2026-11-18-dossier-formats-design.md

## Global Constraints
- Keep regular cron times, announcement gates, and actual predict keyboard.
- Unknown history is unavailable, never zero. No automatic FastF1 integration claim.
- Showcase: 2026-11-19 09:00–10:00 MSK only, both formats, group destination, no automatic retry after ambiguous delivery.

## Review Focus
- Wednesday reminder must include full history, matching the black card.
- Historical facts must match previous year and confirmed circuit.
- Dynamic banner must contain the actual race start and survive rendering failure.
- Showcase must not send early, next year, or twice after rerun/concurrent run.
- Real buttons must retain the actual race ID in both transports.

### Task 1: Shared content and layouts
Files: scripts/telegram/dossier*.js, dossier-banner.js, notify.js, data/race-history.json and relevant tests.
Interfaces: loadDossier returns previousRaceHistory; both builders consume it. Legacy transport renders bannerHtml.
- [x] Write failing tests for full Wednesday content, source/year match, zero vs unknown, top start and arrow-free wind.
- [x] Run node tests and observe missing behavior.
- [x] Implement shared history and production layouts, dynamic black banner, preserve keyboard.
- [x] Run npm test and real Chromium render checks; visually inspect both formats.

### Task 2: One-time showcase and release
Files: scripts/telegram/showcase.js, showcase.test.js, .github/workflows/telegram-showcase.yml, README.md.
Interfaces: runShowcase receives injectable query/load/send; unique per-format UUID claims in job_runs.
- [x] Write failing date-window, deduplication, partial delivery, and real race keyboard tests.
- [x] Implement isolated one-time send without notify.js main side effects; tests, --check read-only validation.
- [x] Verify suite, build and production transports through tests; live read-only check confirms race 24, group destination and zero claims. No group messages sent during implementation.
- [ ] Review changes, commit/push default branch, update project map per AGENTS.md, verify remote state.
