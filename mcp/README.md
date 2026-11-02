# Prospectus MCP server

Prospectus exposes its campaigns as MCP tools so an external agent (opencode, Hermes, Claude Desktop, …) can drive it without the web UI.

Transport: **stdio**, protocol negotiated at `2025-06-18` / `2024-11-05` (Mastra's own MCP 2.x was rejected — it speaks a 2026-only dialect current clients cannot negotiate).

## Run it

```sh
bun run mcp
# or directly
bun mcp/server.ts
```

Environment:

| Variable | Purpose |
|---|---|
| `PROSPECTUS_MCP_USER_EMAIL` | Owner account whose campaigns are exposed. Defaults to the first user. |
| `DATABASE_URL` | Same database the app uses. |

## Client config

opencode (`opencode.json`):

```json
{
  "mcp": {
    "prospectus": {
      "type": "local",
      "command": ["bun", "/abs/path/to/prospectus/mcp/server.ts"],
      "environment": { "PROSPECTUS_MCP_USER_EMAIL": "owner@example.com" }
    }
  }
}
```

Any other stdio client:

```json
{
  "mcpServers": {
    "prospectus": {
      "command": "bun",
      "args": ["/abs/path/to/prospectus/mcp/server.ts"],
      "env": { "PROSPECTUS_MCP_USER_EMAIL": "owner@example.com" }
    }
  }
}
```

## Tools

Read:

| Tool | Returns |
|---|---|
| `list_campaigns` | id, name, niche, area, status, daily goal |
| `campaign_stats` | companies, ready, collecting, companies with email, coverage % |
| `search_prospects` | company, city, website, email, lead status (`emailOnly`, `query`, `limit`) |
| `list_markets` | market queue with `pending/active/saturated` and per-market gains |
| `run_status` | latest run status, result, recent progress events (`eventLimit`) |
| `wait_for_run` | blocks until the run finishes or `timeoutSeconds` (≤120) elapses; returns `timedOut` plus events after an optional `since` cursor |
| `campaign_metrics` | emails/companies added in the last hour and day, queries and leads in 24h, run outcomes with average turns, per-market gains, suppression count |
| `campaign_health` | active/pending/saturated markets, totals, last run + reason, `suggestedAction` |
| `list_runs` | recent run history: status, reason, turns, cost, attempt, timestamps |

Campaign lifecycle:

| Tool | Effect |
|---|---|
| `create_campaign` | create a campaign (niche, area, goal, exclusions, sheet target); markets seed automatically. Idempotent by name — a repeat returns the existing campaign with `created: false` |
| `update_campaign` | change niche/area/goal/turns/schedule/exclusions or the Google Sheets destination |
| `delete_campaign` | remove a campaign and its cascade; requires `confirm: true` |

Run control:

| Tool | Effect |
|---|---|
| `start_run` | enqueue a background job; returns `queueId` immediately. Idempotent with `idempotencyKey`; single-flight per campaign |
| `pause_run` | pause at the next safe checkpoint; state is persisted for resume |
| `resume_run` | continue the paused run from its checkpoint (turn, accepted insights, completed queries) |
| `cancel_run` | mark a queued/running job cancelled; the worker exits within ~10 s |
| `add_market` | append a city × sector market (cap 24 per campaign) |
| `retire_market` | mark a market saturated by `marketId` or `city`; activates the next pending market if it was active |
| `export_prospects` | CSV text of prospects (`emailOnly` supported), page with `cursor`; suppressed addresses are omitted |

Record operations (the "I have a list" flow, independent of runs):

| Tool | Effect |
|---|---|
| `import_list` | upsert rows the user supplies (name + optional email/phone/website/city); returns per-row `imported │ exists │ skipped`, deduped by key and by company name |
| `check_contacts` | for each email: format, domain, MX, role/personal, and whether Prospectus already has it (company + campaigns) |
| `lookup_company` | find a company by name, website domain, or email; returns its emails and the campaigns it appears in |
| `enrich_from_url` | crawl a URL's contact/about pages and return every email found; with `campaignId` + `persist:true` it attaches them to a company |
| `import_suppressions` | record do-not-contact emails/domains; they are excluded from exports and lead rows |

Export control:

- `create_campaign` / `update_campaign` accept `exportMode`:
  - `one_per_company` (default) — one row per company, best email, CRM-friendly
  - `all_contacts` — up to 5 rows per company
- Suppressed emails/domains are filtered from both modes.

Bulk market expansion:

- `add_market` accepts `cities: [...]` (cap 24 per campaign)
- `suggest_markets` ranks unused cities from observed company data, query-ledger yield, and the wilayah.id region registry

Directory bridge (Kemenperin, ≥30k companies with published emails):

| Tool | Effect |
|---|---|
| `search_directory` | one-page lookup by `name` or `kbli`; returns name, phone, email, KBLI |
| `start_ingest` | start a background paginated walk into a campaign; returns `jobId` immediately |
| `ingest_status` | pages done/target, rows, emails, new companies/leads, error |

The ingest runs as a detached process, so it survives the MCP client disconnecting. CLI equivalent:

```sh
bun scripts/ingest-kemenperin.ts <campaignId> <pages> [jobId]
```

Errors come back as structured JSON inside `isError`:

```json
{ "code": "CAMPAIGN_NOT_FOUND", "message": "campaign not found for the configured Prospectus user" }
```

| Code | Meaning |
|---|---|
| `INVALID_ARGUMENTS` | schema or field validation failed |
| `CAMPAIGN_NOT_FOUND` | id unknown for this user |
| `NO_USER` | no Prospectus user; set `PROSPECTUS_MCP_USER_EMAIL` |
| `NO_ACTIVE_RUN` | pause requested with nothing running |
| `CAP_REACHED` | market queue is full |
| `INTERNAL` | unexpected failure |

Concurrency: at most `MAX_ACTIVE_RUNS` (default 3) runs may be queued or running across all campaigns. Further `start_run`/`resume_run` calls return `CAP_REACHED`; HTTP enqueue returns 429.

Health for the orchestrator: `GET /api/health` → `{ status, checks: { database, scraperDaemon }, runs: { queued, running } }`.

A full zero-to-leads flow needs only four calls:

```
create_campaign  → campaignId
start_run        → queueId
wait_for_run     → status, result, events
export_prospects → csv
```

## Semantics the agent needs

- A **campaign** has a niche, an area, a daily goal, and a **market queue**. The goal counts **companies with an email on file**, not raw rows.
- A lead is `ready` only when its company has an email; otherwise it is `new` (collecting).
- A **run** is a durable background job in Postgres. `start_run` returns before any work happens; `run_status` reflects state even if the client disconnected. At most one queued/running job per campaign (DB-enforced).
- When the active market stops producing new companies with email, the run marks it `saturated` and activates the next `pending` market. Add markets to keep a campaign productive.
