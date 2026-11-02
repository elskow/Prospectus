# Query novelty — spatial partitioning groundwork (2026-10-31)

`src/harness/geo-cells.ts` + `ngeohash` provide geohash cell utilities for partitioning
a region into per-cell search jobs: `cellsForRegion(bbox, precision)` (p5 ≈ 4.9 km cells,
~100 cells for greater Surabaya), `cellCenter`, `cellNeighbors` (always query the 8
neighbors — cell-boundary misses are the documented pitfall), `cellSpanKm`,
`companyGeoCell(lat, lng)`.

Research consensus (scout report, 2026-10-31 — sources in transcript):
- Production Maps scrapers (gosom, Octoparse, Apify actors) use **plain lat/lng or km
  grids with per-cell viewport queries**, not geohash strings in query text. Geohash is
  the *bookkeeping* key; the query stays `@lat,lng,zoom`.
- Per-query result caps (~120 on Maps) make **dense cells silently truncated** — the
  fix is cap-hit detection → subdivide cell (higher precision or quarter-cells).
- **Exclusion-driven planning is a dead end for ranked sources**: identical queries
  return identical top-k; everyone dedupes at ingest on `place_id`/dedupeKey instead.
  `-term` exclusions only help in the DDG/searx lane and for exhausted keyword facets.
- **Coverage measurement**: capture-recapture on your own store — overlap-rate OR =
  Σ retrieved / Σ distinct dedupeKeys, estimated coverage P = 1 − OR^(−2.1); per-cell
  consecutive-empty counters give the per-cell stop signal.

Integration path (not yet wired): Maps worker artifacts already carry
`@lat,lng` in `sourceUrl` — extract to `companies.latitude/longitude` (columns exist,
currently unused), then per-turn the planner can enumerate uncovered cells and emit
`keyword × cellCenter` queries, marking cells saturated after consecutive-empty yields.

---

# Run stability fixes — 2026-10-31


## AI contact extraction (replaces regex content scanning)

`contact-extractor` agent (`src/mastra/index.ts`) + `src/harness/contact-ai.ts` extract
emails/phones/WhatsApp/LinkedIn from page text. Grounding rule: every AI-emitted value
must appear verbatim in the source text (`appearsInText`) or it is dropped — the agent
cannot fabricate addresses. Placeholder/webmail junk filtered deterministically.

Wired into all three extraction paths:
- `crawlCompanySite` (`contact-discovery.ts`): deterministic protocol decoders
  (mailto:, tel:, wa.me, Cloudflare-encoded) stay regex-based — they are decoders, not
  extraction. Content scanning is AI. Results merge into `emailsBySource` and surface
  as `crawl.aiContacts` → `buildDiscoveredContacts`.
- `qualify.ts`: AI extraction over deep site content feeds the same upsert path.
- `harvestContactsFromSearch` (`osint-contacts.ts`): AI extraction over third-party
  pages, domain-filtered. Person-email *evidence* matching
  (`harvestPersonEmailEvidence`) keeps its scoped regex: it searches for a specific
  token-bearing address across external pages, a matching problem, not extraction.

**Directory fallback tier** (`osint-contacts.ts`): when the first search pass finds no
email, a second query (`"<company>" (indotrading OR yellowpages OR infobis OR
perusahaan OR daftarperusahaan OR caribisnis OR direktori OR "company profile" OR
profil) kontak email`) fetches up to 3 directory pages and runs the same grounded AI
extraction, merging emails (domain-match OR non-webmail with company-context match),
phones, and WhatsApp. Query form is keyword-hint, not `site:` — DDG rejects
`site:`+quote combinations and rate-limits hard on retries; the keyword form routes
through searxng and returns actual directory listing pages (verified: caribisnis.id,
daftarperusahaan.com). Cost when triggered: 1 search + up to 3 fetches + 1 AI call,
all free infrastructure.

Known limits: sites that render contacts only via JS widgets (csdental.id) yield
nothing until stealth-tier crawling reaches their contact pages; pages with genuinely
no contacts yield nothing (correct behavior, verified on csdental.id and mhdc.co.id).

## Why
Run `f9e1d22d` hung inside an enrich span for ~2.5h (unbounded scrapling MCP SSE read),
then the Nitro worker died of heap exhaustion. The in-app stale-run sweep lived in the
same worker, so nothing reaped the zombie run; heartbeat froze at 21:17 local.

## Fixes
1. **Per-enrich-span hard timeout** (`src/harness/goal-loop/enrich.ts`): every
   `enrichOneLead` is raced against `ENRICH_SPAN_TIMEOUT_MS` (10 min). Timeouts are
   recorded in `state.errors` and emitted; no retry on timeout (retry stays for
   `transient` only).
2. **Bounded MCP response reads** (`src/harness/scrapling.ts`): `rpc()` no longer calls
   `res.text()` on the SSE stream. `readBody()` caps reads at 8 MiB / 30 s and cancels
   the stream reader — a wedged or huge scrapling response can no longer hang a span
   or balloon the heap.
3. **Tracer flush per span** (`src/harness/goal-loop/enrich.ts`): `tracer.flush()` runs
   after every enrich span so Mastra span objects ship to OpenObserve instead of
   accumulating for the whole (possibly unbounded) run.
4. **Bounded site-content cache** (`RunState.cacheContent`, used by enrich + qualify):
   LRU-style cap at 30 entries (~60 KB each) instead of unbounded growth.
5. **Out-of-process stale-run reaper** (`compose.yaml` service `run-reaper`): a
   `postgres:17` sidecar runs every 60 s and fails any `running` row whose
   `heartbeat_at` is >15 min old, plus writes a `run_events` entry. It runs in its own
   container, so it reaps runs even when the Nitro worker is dead/OOM — the exact
   failure mode of 2026-10-30.
6. **Heap ceiling**: `NODE_OPTIONS=--max-old-space-size=2048` on `dev`/`build` scripts
   so runaway allocations throw a fast, local heap error instead of growing until the
   OS kills the process.

## Invariants
- `touchRunHeartbeat` still only updates `running` rows; the reaper only fails
  `running` rows with stale heartbeats. A live run (heartbeat fresh) is never touched.
- The reaper never starts runs; scheduling stays in-app.
