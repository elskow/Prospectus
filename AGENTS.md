# Prospectus Agent Rules

## Code style — MANDATORY

**NEVER write comments. The code should speak itself.**

This includes:

- No `//` or `/* */` comments
- No JSDoc blocks
- No TODO/FIXME markers
- No comment headers separating file sections

If code needs a comment to be understood, rename variables, extract functions,
or restructure until it doesn't. Self-documenting names, small functions, and
explicit types replace comments entirely.

## Domain rules

- **No silent guesses**: every stored attribute is either sourced (with
  provenance) or explicitly an estimate (method + confidence). Nullable means
  "not observed" — never backfill with placeholders ("N/A", "", 0).
- Credentials live in the database (encrypted, entered via web UI). Config
  files declare adapter types only — never secrets.

## Stack

- Runtime: Bun. See CLAUDE.md for Bun API preferences.
- Framework: Nuxt 4 (Nitro server routes), shadcn-vue, @assistant-ui/vue.
- DB: Postgres + Drizzle ORM (schema in `src/db/schema.ts`).
- LLM gateway: self-hosted 9Router (compose service, internal network).
- Scraping: Patchright in Node worker subprocesses — never Playwright
  in-process under Bun.
