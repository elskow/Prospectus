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
