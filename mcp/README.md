# Prospectus MCP server

Prospectus exposes its lead-generation pipeline as MCP tools so an external agent (Hermes, opencode, Claude Desktop, …) can drive it unattended. Transport: **stdio**, protocol `2025-06-18` / `2024-11-05`. Errors come back as structured JSON inside `isError: true`: `{ "code": "...", "message": "..." }`.

## Run

```sh
bun mcp/server.ts
```

| Env | Purpose |
|---|---|
| `PROSPECTUS_MCP_USER_EMAIL` | Owner account whose campaigns are exposed. Defaults to the first user. |
| `DATABASE_URL` | Same Postgres the app uses. |

## Code layout

| File | Contents |
|---|---|
| `mcp/server.ts` | stdio JSON-RPC wiring, annotations, error envelope |
| `mcp/tools/index.ts` | `runTools()` — aggregates all groups |
| `mcp/tools/campaign-tools.ts` | campaign list/stats/metrics/health, search_prospects, agent_brief |
| `mcp/tools/run-tools.ts` | start/cancel/pause/resume/wait_for_run, run_status, list_runs, create/update/delete_campaign |
| `mcp/tools/market-tools.ts` | list/add/suggest/retire_markets |
| `mcp/tools/prospect-tools.ts` | export_prospects, import_list, import_suppressions, check_contacts, lookup_company, enrich_from_url |
| `mcp/tools/directory-tools.ts` | search_directory, start_ingest, ingest_status |
| `mcp/tools/shared.ts` | ToolDefinition, resolveUserId, campaignFor, cursor helpers, spawnWorker |

## Tool groups

**Campaign** — `list_campaigns`, `campaign_stats`, `campaign_metrics`, `campaign_health`, `agent_brief` (one-call heartbeat: campaign identity, goal progress, market queue, latest run, latest ingest, master DB stats — total companies, with email, needs review, rejected, hunt pool — blockers, suggested action), `create_campaign`, `update_campaign`, `delete_campaign` (needs `confirm: true`).

**Runs** — `start_run` (queues a durable background job, returns `queueId` immediately, poll `run_status` or use `wait_for_run`; single-flight per campaign, `CAP_REACHED` when the global run cap is hit), `run_status`, `list_runs`, `pause_run`, `resume_run`, `cancel_run`, `wait_for_run` (blocks up to `timeoutSeconds` ≤120; prefer over polling).

**Markets** — `list_markets`, `add_market` (city × sector, cap 24/campaign), `suggest_markets`, `retire_market`.

**Prospects** — `search_prospects` (rows carry `country`; optional `country` filter), `export_prospects` (CSV `company,city,country,website,email,status`; optional `country` filter; suppressed emails/domains excluded; page with `cursor`), `import_list`, `import_suppressions`, `check_contacts`, `lookup_company` (returns `country`), `enrich_from_url`.

**Directory** — `search_directory` (kemenperin rows carry `country: "Indonesia"`), `start_ingest` (queues a detached background walk, returns `jobId`, poll `ingest_status`), `ingest_status`.

**LLM provider management** — `llm_status`, `llm_add_provider`, `llm_sync_models`, `llm_test`, `llm_set_stages`, `llm_remove_provider`.

## Heartbeat loop

```
agent_brief            → status, master stats, blockers, suggestedAction
act on suggestedAction → start_run / add_market / resume_run / create_campaign
wait_for_run           → blocks until the run finishes (or timeoutSeconds)
export_prospects       → CSV when leads are ready
```

## Error codes

| Code | Meaning |
|---|---|
| `INVALID_ARGUMENTS` | schema or field validation failed; message names the field |
| `CAMPAIGN_NOT_FOUND` | id unknown for the configured user |
| `NO_USER` | no Prospectus user; set `PROSPECTUS_MCP_USER_EMAIL` |
| `NO_ACTIVE_RUN` | pause requested with nothing running |
| `CAP_REACHED` | run or market cap reached; message says what to wait for or retire |
| `INGEST_QUEUE_FAILED` | ingest job row could not be created; retry `start_ingest` |
| `INTERNAL` | unexpected failure |

## Semantics

- A **campaign** has a niche, an area, a daily goal, and a market queue (city × sector). The goal counts **companies with an email on file**, not raw rows.
- A lead is `ready` only when its company has an email; otherwise `new` (collecting).
- Runs and ingests are durable background jobs in Postgres: `start_run`/`start_ingest` return before any work happens and survive client disconnects.
- When the active market stops producing companies with email, the run marks it `saturated` and activates the next `pending` market.
- Every company row returned by the MCP surface carries a `country` (companies are Indonesia, Colombia, Norway, Sri Lanka); `search_prospects` and `export_prospects` accept a `country` filter.
- Concurrency: at most `MAX_ACTIVE_RUNS` (default 3) queued/running across all campaigns; further `start_run`/`resume_run` return `CAP_REACHED`.
