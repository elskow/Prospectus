import { Effect } from "effect";
import { eq } from "drizzle-orm";
import { db } from "@src/db";
import { campaigns, queryLedger } from "@src/db/schema";
import { checkBudget } from "@src/harness/errors";
import { DEFAULT_SAMPLING, type StageSampling } from "@src/harness/stages";
import type { LeadCandidate } from "@src/harness/schemas";
import type { SourceAdapterDefinition } from "@src/adapters/types";
import {
  completePausedRun,
  countReadyLeads,
  countUnassessed,
  finishRun,
  getCampaign,
  getPausedRun,
  persistCandidates,
  promoteReadyLeads,
  pauseRun,
  startRun,
  recordQueryLedger,
  mapsUrlCoords,
  touchRunHeartbeat,
} from "@src/harness/persistence";
import { createRunLifecycle } from "@src/harness/run-lifecycle";
import { createHarnessTracer } from "@src/harness/tracer";
import { refreshVerifierSettings } from "@src/harness/email-verifier";
import { getStagePricing } from "@src/lib/model-settings";
import { RunCost, RunPorts, RunState, RunCostService, RunPortsService, RunStateService, recordFailure, resumeStateOf } from "@src/harness/goal-loop/context";
import { assembleLedgerInsights, ledgerSampleForPrompt } from "@src/harness/goal-loop/planner-insights";
import { crawlSourcesForQuery } from "@src/harness/goal-loop/sources";
import { harvestOneCandidate } from "@src/harness/goal-loop/qualify";
import { selectSourcesForQuery } from "@src/harness/goal-loop/source-selection";
import { pickUncoveredCells, recordCellSweep, resolveRegion } from "@src/harness/geo-ledger";
import { belongsToCell } from "@src/harness/geo-cells";
import { artifactIsKnown, indexCandidate, loadKnownArtifactIndex } from "@src/harness/artifact-filter";
import { runEnrichPass, enrichTargets } from "@src/harness/goal-loop/enrich";
import { runEmailBackfillPass } from "@src/harness/goal-loop/email-backfill-pass";
import { MIN_SATURATION_TURNS, advanceMarket, ensureActiveMarket, recordMarketGain } from "@src/harness/markets";
import { syncReadyLeads } from "@src/harness/goal-loop/sync";
import type { GoalLoopDeps, GoalLoopOptions, GoalLoopResult, ProgressEvent } from "@src/harness/goal-loop/types";

export { runEnrichPass };

const IDLE_TURN_LIMIT = 5;

const EXTRACTION_CONCURRENCY = 8;
const HARVEST_CONCURRENCY = 10;
const HARVEST_CANDIDATES_PER_QUERY = 40;
const MEMORY_CEILING_MB = Number(process.env.RUN_MEMORY_CEILING_MB ?? 1400);

const normalizeQuery = (q: string): string =>
  q
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .trim();

interface RunContext {
  readonly cost: RunCost;
  readonly state: RunState;
  readonly ports: RunPorts;
}

const layerOf = (ctx: RunContext) =>
  Effect.provideService(
    Effect.provideService(Effect.provideService(Effect.void, RunCostService, ctx.cost), RunStateService, ctx.state),
    RunPortsService,
    ctx.ports,
  );

const withContext = <A, E>(ctx: RunContext, effect: Effect.Effect<A, E, RunCost | RunState | RunPorts>): Effect.Effect<A, E> =>
  Effect.flatMap(layerOf(ctx), () =>
    Effect.provideService(
      Effect.provideService(Effect.provideService(effect, RunCostService, ctx.cost), RunStateService, ctx.state),
      RunPortsService,
      ctx.ports,
    ),
  );

export async function runGoalLoop(deps: GoalLoopDeps, options: GoalLoopOptions): Promise<GoalLoopResult> {
  const campaign = await getCampaign(options.campaignId);

  if (!campaign) throw new Error(`campaign ${options.campaignId} not found`);
  const runId = await startRun(options.campaignId, options.trigger, options.runId);
  if (!runId) {
    return {
      status: "already-running",
      runId: "",
      turnsUsed: 0,
      costUsdUsed: 0,
      newReadyLeads: 0,
      totalReadyLeads: await countReadyLeads(options.campaignId),
      errors: [{ stage: "run", code: "already-running", message: "another run is already active for this campaign" }],
    };
  }

  deps.onRunStarted?.(runId);
  void refreshVerifierSettings().catch(() => {});

  const tracer = createHarnessTracer(runId, options.campaignId, runId.replace(/-/g, ""));
  const pricing = await getStagePricing();
  const cost = new RunCost(
    {
      turnsUsed: 0,
      maxTurns: options.maxTurns ?? null,
      costUsdUsed: options.alreadyUsedCostUsd ?? 0,
      wallClockDeadlineMs: options.maxWallClockHours ? Date.now() + options.maxWallClockHours * 3_600_000 : null,
    },
    pricing,
  );
  const lifecycle = createRunLifecycle(cost.budget);
  lifecycle.startHeartbeat(runId);

  const state = new RunState({ ...DEFAULT_SAMPLING });
  const ports = new RunPorts(deps, options, runId, tracer, state);
  const ctx: RunContext = { cost, state, ports };
  const emit = (event: ProgressEvent): void => {
    deps.onProgress?.(event);
    void touchRunHeartbeat(runId).catch(() => {});
  };

  const historyNorms = await db.selectDistinct({ norm: queryLedger.queryNorm }).from(queryLedger).where(eq(queryLedger.campaignId, options.campaignId));
  for (const { norm } of historyNorms) state.completedQueryNorms.add(norm);
  if (historyNorms.length > 0) {
    emit({ stage: "plan", message: `preloaded ${historyNorms.length} historical queries from ledger — planner cannot re-run them verbatim` });
  }

  const exclusions = campaign.exclusions ?? [];
  const market = await ensureActiveMarket(campaign.id, campaign.niche, campaign.area ?? null).catch(() => null);
  const spec: CampaignSpec = {
    niche: market?.sector ?? campaign.niche,
    area: market?.city ?? campaign.area ?? null,
    notes: campaign.notes ?? null,
    exclusions,
    marketId: market?.id,
    marketLabel: market ? `${market.city} × ${market.sector}` : undefined,
  };
  if (market) {
    deps.onProgress?.({ stage: "plan", message: `active market: ${market.city} × ${market.sector}` });
  }

  if (options.resume) {
    const paused = await getPausedRun(options.campaignId);
    if (paused?.resumeState) {
      await completePausedRun(paused.id);
      cost.budget.turnsUsed = paused.turns;
      cost.budget.costUsdUsed += paused.costUsd;
      state.acceptedInsights.push(...paused.resumeState.acceptedInsights);
      for (const norm of paused.resumeState.plannedQueryNorms) state.plannedQueryNorms.add(norm);
      for (const norm of paused.resumeState.completedQueryNorms ?? []) state.completedQueryNorms.add(norm);
      emit({
        stage: "harvest",
        message: `resuming paused run ${paused.id} at turn ${paused.turns} ($${paused.costUsd.toFixed(2)} already spent, ${state.completedQueryNorms.size} queries already completed)`,
      });
    } else {
      emit({ stage: "harvest", message: "resume requested but no paused run found; starting fresh" });
    }
  }

  let status: GoalLoopResult["status"] = "goal-unmet";
  let reason: string | undefined;

  try {
    const startCount = await countReadyLeads(options.campaignId);

    const outcome = await runTurns(ctx, spec, startCount);
    status = outcome.status;
    reason = outcome.reason;

    await syncReadyLeads(options, runId, { emit });

    await lifecycle.finish(
      runId,
      cost.budget,
      status === "failed" ? "failed" : status === "cancelled" ? "cancelled" : "succeeded",
      status === "goal-unmet" || status === "budget-exhausted" ? (reason ?? status) : undefined,
    );

    emit({ stage: "done", message: `run finished: ${status}${reason ? ` (${reason})` : ""}` });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordFailure(state.errors, "run", "run-failed", message);
    status = "failed";
    reason = message;
    await lifecycle.finish(runId, cost.budget, "failed", message);
  }

  return {
    status,
    reason,
    runId,
    turnsUsed: cost.budget.turnsUsed,
    costUsdUsed: cost.budget.costUsdUsed,
    newReadyLeads: state.newReady,
    totalReadyLeads: await countReadyLeads(options.campaignId),
    errors: state.errors,
  };
}

interface CampaignSpec {
  niche: string;
  area: string | null;
  notes: string | null;
  exclusions: string[];
  marketId?: string;
  marketLabel?: string;
}

const CELLS_PER_TURN = 3;
const CELL_SWEEP_MAX_RESULTS = 40;
const CELL_SWEEP_TURN_BUDGET_MS = 180_000;

interface CellSweepResult {
  artifacts: Awaited<ReturnType<SourceAdapterDefinition["crawl"]>>["artifacts"];
  sourceId: string | null;
}

async function cellSweepPass(ctx: RunContext, spec: CampaignSpec, query: string, sampling: StageSampling): Promise<CellSweepResult> {
  const { ports, state } = ctx;
  const { options, runId, deps } = ports;
  const empty: CellSweepResult = { artifacts: [], sourceId: null };
  const mapsSource = deps.sources.find((s) => s.adapter.type === "source:google-maps");
  if (!mapsSource) return empty;

  const region = await resolveRegion(options.campaignId, spec.area);
  if (!region) return empty;

  const candidates = await pickUncoveredCells(options.campaignId, spec.niche, spec.area, region);
  const fresh = candidates.filter((c) => !state.cellsSweptThisRun.has(c.hash)).slice(0, CELLS_PER_TURN);
  for (const cell of fresh) state.cellsSweptThisRun.add(cell.hash);
  if (fresh.length === 0) return empty;

  ports.emit({ stage: "scrape", message: `cell sweep: ${fresh.length} cell(s) for "${query}"` });

  const collected: CellSweepResult["artifacts"] = [];
  let sourceId: string | null = null;

  const sweepOne = async (cell: { hash: string; lat: number; lng: number }) => {
    if (deps.shouldCancel?.() || deps.shouldPause?.()) return;
    const outcome = await Effect.runPromise(
      withContext(
        ctx,
        crawlSourcesForQuery({
          sources: [mapsSource],
          query,
          userId: options.userId,
          runId,
          burnedStems: [],
          sampling,
          viewport: { lat: cell.lat, lng: cell.lng, zoom: 14 },
          maxResults: CELL_SWEEP_MAX_RESULTS,
          detail: "list",
        }),
      ),
    );
    const artifacts = outcome.flatMap((o) => o.artifacts);
    const attributable = artifacts.filter((a) => {
      const coords = mapsUrlCoords(a.sourceUrl);
      return coords ? belongsToCell(cell.hash, coords.lat, coords.lng) : false;
    });
    await recordCellSweep({
      campaignId: options.campaignId,
      niche: spec.niche,
      area: spec.area,
      cellHash: cell.hash,
      newCompanies: attributable.length,
      capHit: artifacts.length >= CELL_SWEEP_MAX_RESULTS,
    });
    ports.emit({
      stage: "scrape",
      message: `cell ${cell.hash}: ${attributable.length}/${artifacts.length} artifacts in cell area${artifacts.length >= CELL_SWEEP_MAX_RESULTS ? " (cap hit — subdividing next)" : ""}`,
    });
    return { artifacts, sourceId: outcome.find((o) => o.artifacts.length > 0)?.sourceId ?? null };
  };

  const queue = [...fresh];
  const total = queue.length;
  const sweepStartedAt = Date.now();
  while (queue.length > 0) {
    if (deps.shouldCancel?.() || deps.shouldPause?.()) return { artifacts: collected, sourceId };
    if (Date.now() - sweepStartedAt > CELL_SWEEP_TURN_BUDGET_MS) {
      ports.emit({ stage: "scrape", message: `cell sweep budget spent — skipping ${queue.length} remaining cell(s) this turn` });
      break;
    }
    const cell = queue.shift();
    if (!cell) break;
    ports.emit({
      stage: "scrape",
      message: `cell ${cell.hash}: sweeping (${total - queue.length}/${total}) at ${cell.lat.toFixed(3)},${cell.lng.toFixed(3)}`,
    });
    const result = await sweepOne(cell);
    if (!result) continue;
    collected.push(...result.artifacts);
    sourceId = result.sourceId ?? sourceId;
    if (result.artifacts.length === 0 && queue.length > 0) {
      ports.emit({ stage: "scrape", message: `cell ${cell.hash} yielded nothing — skipping ${queue.length} remaining cell(s) this turn` });
      break;
    }
  }

  return { artifacts: collected, sourceId };
}

async function runTurns(ctx: RunContext, spec: CampaignSpec, startCount: number): Promise<{ status: GoalLoopResult["status"]; reason?: string }> {
  const { cost, state, ports } = ctx;
  const { options, deps, runId, tracer } = ports;
  const emit = (event: ProgressEvent): void => ports.emit(event);
  const errors = state.errors;

  const pauseForMemory = async (usedMb: number): Promise<GoalLoopResult["status"]> => {
    await pauseRun(runId, cost.budget.turnsUsed, cost.budget.costUsdUsed, resumeStateOf(state, options.goalNewReadyLeads, state.stallTurns));
    emit({
      stage: "done",
      message: `heap ceiling reached (${usedMb} MB of ${MEMORY_CEILING_MB} MB) — run paused before the process could die; resume to continue`,
    });
    return "budget-exhausted";
  };

  let status: GoalLoopResult["status"] = "goal-unmet";
  let reason: string | undefined;

  state.knownArtifacts = await loadKnownArtifactIndex().catch(() => state.knownArtifacts);

  while (true) {
    let pauseRequested = false;
    const heapMb = Math.round(process.memoryUsage().heapUsed / 1_048_576);
    if (heapMb >= MEMORY_CEILING_MB) {
      status = await pauseForMemory(heapMb);
      break;
    }

    const decision = checkBudget(cost.budget);
    if (!decision.allowed) {
      status = "budget-exhausted";
      await pauseRun(runId, cost.budget.turnsUsed, cost.budget.costUsdUsed, resumeStateOf(state, options.goalNewReadyLeads, state.stallTurns));
      emit({ stage: "done", message: `${decision.reason ?? "budget exhausted"} — run paused, can be resumed` });
      break;
    }

    if (deps.shouldCancel?.()) {
      status = "cancelled";
      break;
    }

    if (deps.shouldPause?.()) {
      await pauseRun(runId, cost.budget.turnsUsed, cost.budget.costUsdUsed, resumeStateOf(state, options.goalNewReadyLeads, state.stallTurns));
      emit({ stage: "done", message: "paused by user — resume to continue" });
      status = "budget-exhausted";
      break;
    }

    const totalNow = await countReadyLeads(options.campaignId);
    if (totalNow - startCount >= options.goalNewReadyLeads) {
      status = "succeeded";
      emit({ stage: "done", message: `goal met: +${totalNow - startCount} companies with email` });
      break;
    }

    cost.budget.turnsUsed += 1;
    const newReadyBeforeTurn = state.newReady;
    let turnDiscovered = 0;
    emit({
      stage: "turn",
      message: `turn ${cost.budget.turnsUsed}/${cost.budget.maxTurns} · +${state.newReady}/${options.goalNewReadyLeads} companies with email this run`,
    });

    const ledger = await assembleLedgerInsights(options.campaignId);
    const ledgerBlock = await ledgerSampleForPrompt(options.campaignId);

    const insights: string[] = [
      spec.niche ? `Niche: ${spec.niche}` : "",
      spec.area ? `Area: ${spec.area}` : "",
      spec.notes ? `Stakeholder notes: ${spec.notes}` : "",
    ];
    if (ledger.exhausted.length > 0)
      insights.push(
        `Previously crawled with zero leads (do not repeat these): ${ledger.exhausted
          .slice(0, 15)
          .map((q) => `"${q}"`)
          .join(", ")}`,
      );
    if (ledger.productive.length > 0)
      insights.push(`Historically productive queries: ${ledger.productive.map((p) => `"${p.query}" (${p.leads} leads)`).join(", ")}`);
    if (ledgerBlock) insights.push(`Full query ledger (recent first is oldest): ${ledgerBlock.slice(0, 3000)}`);
    if (spec.exclusions.length > 0) insights.push(`EXCLUDED business types (never plan queries toward these): ${spec.exclusions.join("; ")}`);

    const recitation = [
      `RUN STATE (recited every turn): turn ${cost.budget.turnsUsed}${cost.budget.maxTurns != null ? `/${cost.budget.maxTurns}` : " (unbounded — run ends when the lead goal is met or queries are exhausted)"}`,
      `companies with email this run: +${state.newReady} of goal ${options.goalNewReadyLeads} (need ${Math.max(0, options.goalNewReadyLeads - state.newReady)} more)`,
      state.idleTurns > 0
        ? `CONTINUATION MODE: the last ${state.idleTurns} turn(s) produced nothing new — change strategy fundamentally rather than rephrasing`
        : "",
    ]
      .filter(Boolean)
      .join(" | ");
    insights.unshift(recitation);

    if (state.stallTurns >= 4 && cost.budget.maxTurns === null) {
      emit({
        stage: "done",
        message: `goal unreachable: ${state.stallTurns} consecutive stall turns in unbounded mode; stopping instead of burning wall-clock`,
      });
      break;
    }

    const sampling: StageSampling = {
      ...DEFAULT_SAMPLING,
      planner: Math.min(1, DEFAULT_SAMPLING.planner + state.stallTurns * 0.25),
      extractor: Math.min(0.6, DEFAULT_SAMPLING.extractor + state.stallTurns * 0.1),
    };
    state.sampling = sampling;

    const planResult = await deps.stages.planQueries(spec, state.acceptedInsights, sampling);
    cost.trackUsage("planner", planResult.usage);
    const plan = planResult.value;

    const seenThisRun: string[] = [];
    plan.queries = plan.queries.filter((q) => {
      const norm = normalizeQuery(q);
      if (state.plannedQueryNorms.has(norm) || state.completedQueryNorms.has(norm)) {
        seenThisRun.push(q);
        return false;
      }
      state.plannedQueryNorms.add(norm);
      return true;
    });

    if (plan.queries.length === 0) {
      state.duplicatePlanStreak += 1;
      if (state.duplicatePlanStreak >= 2) {
        emit({ stage: "done", message: `planner exhausted distinct queries (${seenThisRun.join(", ")} all seen); stopping` });
        break;
      }
      emit({ stage: "plan", message: `planner returned only duplicate queries (${seenThisRun.join(", ")}); re-planning` });
      continue;
    }
    state.duplicatePlanStreak = 0;

    emit({ stage: "plan", message: `planned ${plan.queries.length} queries`, data: plan.queries });

    await runEmailBackfillPass(ports).catch((error) => {
      recordFailure(errors, "persist", "email-backfill-failed", `email backfill pass failed: ${error instanceof Error ? error.message : String(error)}`);
    });

    const primaryQuery = plan.queries[0];
    const sweep = primaryQuery ? await cellSweepPass(ctx, spec, primaryQuery, sampling) : { artifacts: [], sourceId: null };
    let sweepPending = sweep.artifacts.length > 0;

    for (const query of plan.queries) {
      const totalAfterCheck = await countReadyLeads(options.campaignId);
      if (totalAfterCheck - startCount >= options.goalNewReadyLeads) {
        status = "succeeded";
        break;
      }

      const queryHeapMb = Math.round(process.memoryUsage().heapUsed / 1_048_576);
      if (queryHeapMb >= MEMORY_CEILING_MB) {
        status = await pauseForMemory(queryHeapMb);
        break;
      }

      if (deps.shouldCancel?.()) {
        status = "cancelled";
        break;
      }

      if (deps.shouldPause?.()) {
        pauseRequested = true;
        break;
      }

      const queryNorm = normalizeQuery(query);
      if (state.completedQueryNorms.has(queryNorm)) continue;
      const priorYield = (await (await import("@src/harness/persistence")).getQueryYields(options.campaignId)).get(query);
      if (priorYield && priorYield.crawled >= 15 && priorYield.ready === 0) {
        emit({ stage: "scrape", message: `skipping "${query}" (0 leads in ${priorYield.crawled} prior runs)` });
        continue;
      }

      const sourcesForQuery = selectSourcesForQuery(deps.sources, [], query);

      if (sourcesForQuery.length === 0) {
        recordFailure(errors, "scrape", "no-sources", "no usable source adapters configured for this user");
        break;
      }

      const outcomes = await Effect.runPromise(
        withContext(
          ctx,
          crawlSourcesForQuery({
            sources: sourcesForQuery,
            query,
            userId: options.userId,
            runId,
            burnedStems: [...new Set(state.plannedQueryNorms)].map((norm) => norm.split(" ").slice(0, 3).join(" ")),
            sampling,
          }),
        ),
      );

      const planned: { sourceId: string; artifacts: Awaited<ReturnType<SourceAdapterDefinition["crawl"]>>["artifacts"]; label: string }[] = [];
      let resultCount = 0;
      for (const outcome of outcomes) {
        if (outcome.failedMessage) {
          recordFailure(errors, "scrape", "source-failed", outcome.failedMessage);
          continue;
        }
        for (const warning of outcome.warnings) recordFailure(errors, "scrape", "source-warning", warning);
        resultCount += outcome.artifacts.length;
        planned.push({ sourceId: outcome.sourceId, artifacts: outcome.artifacts, label: outcome.label });
      }

      if (sweepPending && sweep.sourceId) {
        planned.push({ sourceId: sweep.sourceId, artifacts: sweep.artifacts, label: "Google Maps scraper (cell sweep)" });
        resultCount += sweep.artifacts.length;
        emit({ stage: "scrape", message: `${sweep.artifacts.length} cell-sweep artifacts queued for extraction with "${query}"` });
        sweepPending = false;
      }

      for (const fetched of planned) {
        emit({ stage: "scrape", message: `"${query}" → ${fetched.artifacts.length} artifacts (${fetched.label})` });
      }

      const knownIndex = state.knownArtifacts;
      let droppedKnown = 0;
      const freshBatch = planned
        .map((fetched) => {
          const artifacts = fetched.artifacts.filter((artifact) => {
            if (!artifactIsKnown(knownIndex, artifact)) return true;
            droppedKnown += 1;
            return false;
          });
          return { ...fetched, artifacts };
        })
        .filter((fetched) => fetched.artifacts.length > 0);

      if (droppedKnown > 0) {
        emit({ stage: "scrape", message: `skipped ${droppedKnown} already-known artifact(s) before extraction for "${query}"` });
      }

      const batch = freshBatch;
      const totalArtifacts = batch.reduce((sum, f) => sum + f.artifacts.length, 0);

      let extraction: { candidates: LeadCandidate[]; droppedCount: number; quarantined?: boolean } | null = null;
      if (totalArtifacts > 0) {
        const extractionStartedAt = Date.now();
        const chunkSize = 5;
        const chunks: { sourceId: string; label: string; artifacts: (typeof batch)[number]["artifacts"] }[] = [];
        for (const fetched of batch) {
          for (let i = 0; i < fetched.artifacts.length; i += chunkSize) {
            chunks.push({ sourceId: fetched.sourceId, label: fetched.label, artifacts: fetched.artifacts.slice(i, i + chunkSize) });
          }
        }

        extraction = { candidates: [], droppedCount: 0 };
        let failedChunks = 0;
        let quarantinedChunks = 0;
        const chunkQueue = [...chunks];
        const extractionWorkers = Array.from({ length: Math.min(EXTRACTION_CONCURRENCY, chunkQueue.length) }, async () => {
          while (true) {
            if (deps.shouldCancel?.() || deps.shouldPause?.()) return;
            const chunk = chunkQueue.shift();
            if (!chunk) return;
            try {
              const extractResult = await deps.stages.extractCandidates(chunk.artifacts, sampling);
              cost.trackUsage("extractor", extractResult.usage);
              if ((extractResult.value as { quarantined?: boolean }).quarantined) {
                quarantinedChunks += 1;
                continue;
              }
              extraction?.candidates.push(...extractResult.value.candidates);
              if (extraction) extraction.droppedCount += extractResult.value.droppedCount;
            } catch (error) {
              failedChunks += 1;
              const message = error instanceof Error ? error.message : String(error);
              recordFailure(errors, "extract", "extraction-chunk-failed", `extraction chunk failed for "${query}" (${chunk.label}): ${message}`);
            }
          }
        });
        await Promise.all(extractionWorkers);
        if (failedChunks > 0 || quarantinedChunks > 0) {
          emit({
            stage: "error",
            message: `${failedChunks} failed / ${quarantinedChunks} quarantined chunk(s) of ${chunks.length} for "${query}"`,
          });
        }
        if (failedChunks === chunks.length) {
          extraction = null;
          emit({ stage: "error", message: `extraction failed for "${query}": all ${chunks.length} chunk(s) failed` });
        }
        if (extraction) {
          emit({
            stage: "extract",
            message: `${extraction.candidates.length} candidates extracted from ${totalArtifacts} artifacts in ${chunks.length} chunk(s) (${Math.round((Date.now() - extractionStartedAt) / 1000)}s)`,
          });
        }
      }

      let newLeadsFromQuery = 0;

      const sourceIdByLabel = new Map(batch.map((f) => [f.label, f.sourceId]));
      const placeUrlByName = new Map<string, string>();
      for (const fetched of batch) {
        for (const artifact of fetched.artifacts) {
          if (artifact.sourceUrl) placeUrlByName.set(artifact.name.toLowerCase(), artifact.sourceUrl);
        }
      }

      if (extraction && extraction.candidates.length > 0) {
        const candidatesWithSource = extraction.candidates.map((c) => ({
          ...c,
          sourceUrl: c.sourceUrl ?? placeUrlByName.get(c.name.toLowerCase()) ?? null,
        }));

        const candidatesBySource = new Map<string, typeof candidatesWithSource>();
        for (const candidate of candidatesWithSource) {
          const label = candidate.sourceUrl?.includes("google.com/maps")
            ? "Google Maps scraper"
            : candidate.sourceUrl?.includes("instagram.com")
              ? "Instagram"
              : "Web search";
          const list = candidatesBySource.get(label) ?? [];
          list.push(candidate);
          candidatesBySource.set(label, list);
        }

        for (const [label, candidates] of candidatesBySource) {
          const sourceId = sourceIdByLabel.get(label) ?? batch[0]?.sourceId;
          if (!sourceId) continue;
          const persist = await persistCandidates({ campaignId: options.campaignId, runId, sourceId, candidates });
          emit({ stage: "persist", message: `+${persist.newLeads} new companies, ${persist.duplicates} duplicates (${label})` });
          newLeadsFromQuery += persist.newLeads;
          turnDiscovered += persist.newLeads;
          for (const candidate of candidates) indexCandidate(state.knownArtifacts, candidate);
        }

        const promotedNow = await promoteReadyLeads(options.campaignId).catch(() => 0);
        if (promotedNow > 0) {
          state.newReady += promotedNow;
          state.stallTurns = 0;
          if (!state.acceptedInsights.includes(query)) state.acceptedInsights.push(query);
          emit({ stage: "persist", message: `+${promotedNow} prospect rows ready (contact on file)` });
        }

        await recordQueryLedger({
          campaignId: options.campaignId,
          query,
          queryNorm,
          backend: sourcesForQuery[0]?.adapter.type ?? "unknown",
          resultCount,
          leadsProduced: newLeadsFromQuery,
          runId,
        } as never).catch(() => {});

        for (const [label, candidates] of candidatesBySource) {
          const sourceId = sourceIdByLabel.get(label) ?? batch[0]?.sourceId;
          if (!sourceId) continue;

          await Effect.runPromise(
            withContext(
              ctx,
              Effect.forEach(
                candidates.slice(0, HARVEST_CANDIDATES_PER_QUERY),
                (candidate) =>
                  harvestOneCandidate({
                    ports,
                    cost,
                    tracer,
                    sourceId,
                    candidate,
                    exclusions: spec.exclusions,
                    siteContentCache: state.siteContentCache,
                    errors,
                    sampling,
                    onReady: () => {
                      state.newReady += 1;
                      state.stallTurns = 0;
                      if (!state.acceptedInsights.includes(query)) state.acceptedInsights.push(query);
                    },
                  }),
                { concurrency: HARVEST_CONCURRENCY, discard: true },
              ),
            ),
          );
        }

        emit({ stage: "harvest", message: `contact harvest pass done for "${query}"` });
      }

      state.completedQueryNorms.add(queryNorm);

      if (!deps.shouldCancel?.() && !deps.shouldPause?.()) {
        await enrichPass(ctx, sampling, 8);
      }
    }

    if (pauseRequested || deps.shouldPause?.()) {
      await pauseRun(runId, cost.budget.turnsUsed, cost.budget.costUsdUsed, resumeStateOf(state, options.goalNewReadyLeads, state.stallTurns));
      emit({ stage: "done", message: "paused by user — resume to continue" });
      status = "budget-exhausted";
      break;
    }

    await enrichPass(ctx, sampling);
    await runEmailBackfillPass(ports).catch((error) => {
      recordFailure(errors, "persist", "email-backfill-failed", `email backfill pass failed: ${error instanceof Error ? error.message : String(error)}`);
    });

    if (status === "succeeded") break;
    const turnEmailed = state.newReady - newReadyBeforeTurn;
    if (spec.marketId) {
      await recordMarketGain(spec.marketId, turnDiscovered, turnEmailed).catch(() => {});
    }

    if (state.newReady === newReadyBeforeTurn) {
      state.stallTurns += 1;
      state.idleTurns += 1;
    } else {
      state.stallTurns = 0;
      state.idleTurns = 0;
    }

    if (state.stallTurns >= MIN_SATURATION_TURNS) {
      const next = await advanceMarket(options.campaignId).catch(() => null);
      if (next) {
        spec.marketId = next.id;
        spec.marketLabel = `${next.city} × ${next.sector}`;
        spec.niche = next.sector;
        spec.area = next.city;
        state.stallTurns = 0;
        state.idleTurns = 0;
        emit({ stage: "plan", message: `market saturated → advancing to ${next.city} × ${next.sector}` });
      } else {
        emit({ stage: "done", message: "all markets saturated — no pending market left; add markets to continue" });
        status = "goal-unmet";
        break;
      }
    }
    if (state.idleTurns >= IDLE_TURN_LIMIT) {
      status = "budget-exhausted";
      await pauseRun(runId, cost.budget.turnsUsed, cost.budget.costUsdUsed, resumeStateOf(state, options.goalNewReadyLeads, state.stallTurns));
      emit({
        stage: "done",
        message: `${IDLE_TURN_LIMIT} consecutive turns without any new candidate — continuation nudge exhausted; run paused, can be resumed`,
      });
      break;
    }
    if (state.idleTurns > 0) {
      const extractionFailures = errors.filter((failure) => failure.code === "extraction-chunk-failed").length;
      emit({
        stage: "turn",
        message:
          extractionFailures > 0
            ? `continuation nudge: turn produced no new candidates (${state.idleTurns}/${IDLE_TURN_LIMIT} idle) — ${extractionFailures} extraction failure(s) this run; retries next turn`
            : `continuation nudge: turn produced no new candidates (${state.idleTurns}/${IDLE_TURN_LIMIT} idle) — next turn must change strategy, not repeat`,
      });
    }

    await enrichPass(ctx, sampling);
  }

  return { status, reason };
}

async function enrichPass(ctx: RunContext, sampling: StageSampling, limit = 40): Promise<void> {
  const { ports, state, cost } = ctx;
  const targets = await enrichTargets(ports.options.campaignId, limit);
  if (targets.length === 0) return;
  await runEnrichPass(
    {
      stages: ports.deps.stages,
      options: ports.options,
      runId: ports.runId,
      tracer: ports.tracer,
      sources: ports.deps.sources,
      trackUsage: cost.trackUsage,
      errors: state.errors,
      state,
      siteContentCache: state.siteContentCache,
      crawlState: state.crawlState,
      emit: (event) => ports.emit(event),
      shouldCancel: ports.deps.shouldCancel,
    },
    targets,
  );
  void sampling;
}
