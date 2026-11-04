# Prospectus architecture

Prospectus is a durable lead-generation pipeline. Postgres is the queue and the source of truth; the web UI and the MCP server are two clients over the same services.

## Layers

```
UI (Nuxt pages) ─┐
MCP (stdio)      ├─→ services (src/harness) ─→ Postgres
HTTP API         ┘                             ├─→ run workers
                                               └─→ scraper daemon
```

| Layer | Responsibility |
|---|---|
| `src/harness/goal-loop` | turn loop: plan → scrape → extract → persist → enrich → backfill → sync |
| `src/harness/markets.ts` | market queue (city × sector), saturation progression |
| `src/harness/run-queue.ts` | enqueue, status, cancel — all Postgres |
| `src/harness/persist/runs.ts` | leases, claims, requeue |
| `workers/run-worker.ts` | one process per run; claims by id, renews lease, exits on cancel |
| `server/utils/run-spawner.ts` | spawns workers, dispatches orphaned queued runs |
| `workers/google-maps.cjs` | scraper daemon: one browser per proxy key, NDJSON over TCP |
| `mcp/` | MCP server exposing campaigns to external agents |

## Run lifecycle

```
POST /campaigns/:id/run-queue
  └─ INSERT runs(status='queued', request=…, idempotency_key=…)
       └─ spawn `bun workers/run-worker.ts <id>`
            └─ claim: status='running', lease_owner, lease_expires_at=+120s, attempt+1
                 └─ runGoalLoop(options.runId)
                      └─ finishRun: status succeeded│failed│cancelled│paused
```

Guarantees:

- **Single-flight per campaign** — partial unique index on `(campaign_id) where status in ('queued','running')`.
- **Idempotent enqueue** — unique `(campaign_id, idempotency_key)`; repeats return the existing run.
- **Crash recovery** — lease expires after 120 s without renewal; the dispatcher requeues while `attempt < 2`, then fails the run.
- **Cancellation** — status flips to `cancelled`; the worker notices within 3 s and hard-exits after an 8 s grace period.
- **Durability** — a job inserted before a crash is claimed by the dispatcher on the next tick (every 20 s).

## Markets

A campaign owns a queue of markets seeded from `area` × `niche`. Each run activates one market and uses its city/sector as the planner constraint. When three consecutive turns produce no new company with email, the market is marked `saturated` and the next `pending` market is activated. With no pending market left the run stops with `goal-unmet` and a message naming the cause. Per-market `discovered`/`emailed` counters are the truthful progress surface in the UI and MCP.

## Scraper

`workers/google-maps.cjs` runs as a daemon (`MAPS_DAEMON_PORT`, default 9710) started by `server/plugins/maps-daemon.ts`. Each client — the server or any run worker — connects over TCP and sends NDJSON frames. The daemon keeps **one browser per proxy key** (`proxyUrl` in the payload), serializes requests per key, and evicts idle sessions after `MAPS_DAEMON_IDLE_MS`. Clients fall back to spawning a private worker when no daemon answers.

The Cloudflare-fronted directory adapters (`indotrading`, `indonetwork`) fetch via a plain bun-subprocess transport first (cheap path); when the response looks like a Cloudflare challenge (403 or challenge markers — titles are locale-dependent, e.g. "Tunggu sebentar…"), `src/harness/ingest/cf-fetch.ts` retries the same URL through `workers/stealth-fetch.cjs` (Patchright headless Chromium, `patchrightStealthFetch`), which renders the interstitial natively — no clearance cookie or cache involved.

## Master data

Companies and contacts are a global, deduplicated asset independent of campaigns; a campaign lead references a master company. The deliverable is a company row with an email.

| Piece | Responsibility |
|---|---|
| `src/harness/ingest/registry.ts` | `DirectoryAdapter` contract (`firstPage`/`nextPage` returning rows + cursor); adapters self-register |
| `src/harness/ingest/kemenperin.ts` | reference adapter scraping the Kemenperin company directory |
| `src/harness/ingest/kemendagexim.ts` | `kemendag-exim` adapter scraping the Kemendag export-import directory |
| `src/harness/ingest/run.ts` | generic runner: pages → `LeadCandidate`s → `persistCandidates`; counts pages/rows/withEmail/newCompanies/duplicates/rejected/flagged |
| `POST /api/ingest/run` | starts a directory ingest (`{ adapterId, pages }`), returns counters |
| `GET /api/master/*` | master read API: stats (cached 60 s), company list (keyset pagination via `nextCursor`, `reachable=email` filters on the `has_email` partial index), single company, CSV export (`/api/master/companies.csv`) |
| `POST /api/hunt/jobs` | on-demand email hunt; row in `hunt_jobs` (`queued → running → succeeded/failed/cancelled`) tracks `requestedCount`/`processedCount`/`emailsFound`; targets need a website and `email_hunt_attempts < 2` (max two attempts per company) |
| `POST /api/campaigns/import` | inserts existing master companies as campaign leads (`created_by_run_id` null, status `new`, then `promoteReadyLeads`); already-present companies count as `duplicates`, not errors; `hunt:true` starts a scoped hunt job for the imported companies |

Validation gate (`src/harness/validation.ts`): every candidate gets a verdict —
`reject` (blank or generic name) never touches the database, `review` (malformed
email, unusable phone, non-http website) stores the company with
`status='needs_review'` plus machine-readable `validation_notes`, `accept` stores
`status='valid'`. `has_email` is a maintained flag recomputed from contacts on
every contact write (`refreshCompanyEmailFlag`).

```
directory adapter (kemenperin · kemendag-exim)
  └─ POST /api/ingest/run { adapterId, pages }
       └─ run.ts: pages → LeadCandidates
            ├─ validation.ts gate: accept → status='valid'
            │                      review → status='needs_review' + validation_notes
            │                      reject → dropped
            └─ persistCandidates: dedupe on companies.dedupe_key,
               contacts conflict-upsert, refreshCompanyEmailFlag
                 ├─ GET /api/master/* (list · stats · CSV)
                 ├─ POST /api/hunt/jobs → hunt_jobs → crawl/role/pattern backfill
                 │     (targets: website present, email_hunt_attempts < 2)
                 └─ POST /api/campaigns/import → leads(status='new',
                       created_by_run_id=null) → promoteReadyLeads
```

## Email readiness

A lead is `ready` only when its company has a contact email. Three sources feed that:

1. observed emails from crawled pages;
2. role inboxes (`info@domain`) when the domain has live MX;
3. a per-turn backfill pass that revisits companies with a website but no email.

Promotion is a single statement: `update leads … where status='new' and exists (select 1 from contacts where email is not null)`.

## Verification

```sh
bunx tsc --noEmit                 # typecheck
curl -s localhost:3000/api/health # db + scraper daemon + queue counts
bun run mcp                       # MCP server over stdio
```
