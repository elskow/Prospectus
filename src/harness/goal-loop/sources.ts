import { Effect } from "effect";
import type { SourceAdapterDefinition } from "@src/adapters/types";
import type { StageSampling } from "@src/harness/stages";
import { ensureSource } from "@src/harness/persistence";
import { RunPortsService, type RunPorts } from "@src/harness/goal-loop/context";
import { SourceFatalError, SourceTransientError, fromSourceOperation, sourceRetrySchedule } from "@src/harness/goal-loop/errors";
import type { ResolvedSource } from "@src/harness/source-resolver";

type CrawlArtifacts = Awaited<ReturnType<SourceAdapterDefinition["crawl"]>>["artifacts"];

export interface CrawlOutcome {
  readonly sourceId: string;
  readonly artifacts: CrawlArtifacts;
  readonly label: string;
  readonly warnings: readonly string[];
  readonly failedMessage: string | null;
}

interface CrawlAttempt {
  readonly artifacts: CrawlArtifacts;
  readonly warnings: readonly string[];
}

const PER_QUERY_ARTIFACT_BUDGET = 120;

const crawlOne = (
  resolved: ResolvedSource,
  query: string,
  maxResults: number,
  ctx: { userId: string; runId: string; credentials: Record<string, string> },
  viewport?: { lat: number; lng: number; zoom?: number } | null,
  detail?: "full" | "list",
) => fromSourceOperation(() => resolved.adapter.crawl({ query, maxResults, viewport: viewport ?? null, detail }, ctx)).pipe(Effect.retry(sourceRetrySchedule));

export const crawlSourcesForQuery = Effect.fnUntraced(function* (input: {
  readonly sources: ResolvedSource[];
  readonly query: string;
  readonly userId: string;
  readonly runId: string;
  readonly burnedStems: string[];
  readonly sampling: StageSampling;
  readonly viewport?: { lat: number; lng: number; zoom?: number } | null;
  readonly maxResults?: number;
  readonly detail?: "full" | "list";
}): Effect.fn.Return<CrawlOutcome[], never, RunPorts> {
  const ports: RunPorts = yield* RunPortsService;
  const budget = input.maxResults ?? PER_QUERY_ARTIFACT_BUDGET;

  const outcomes = yield* Effect.forEach(
    input.sources,
    Effect.fnUntraced(function* (resolved): Effect.fn.Return<CrawlOutcome> {
      const sourceId = yield* Effect.promise(() => ensureSource(resolved.adapter.type, input.query));

      const crawl = yield* crawlOne(
        resolved,
        input.query,
        budget,
        { userId: input.userId, runId: input.runId, credentials: resolved.credentials },
        input.viewport,
        input.detail,
      ).pipe(
        Effect.catch((error) =>
          Effect.succeed({
            artifacts: [] as CrawlArtifacts,
            warnings: [] as readonly string[],
            failure: error as SourceFatalError | SourceTransientError,
          }),
        ),
      );

      if ("failure" in crawl) {
        const label = resolved.adapter.label;
        const message =
          crawl.failure._tag === "SourceFatalError"
            ? `${label} fatal on "${input.query}": ${String(crawl.failure.cause)}`
            : `${label} transient on "${input.query}" after retries: ${String(crawl.failure.cause)}`;
        return { sourceId, artifacts: [], label, warnings: [], failedMessage: message };
      }

      let final: CrawlAttempt = { artifacts: crawl.artifacts, warnings: crawl.warnings };
      if (crawl.artifacts.length === 0) {
        const expansions = yield* Effect.promise(() =>
          ports.deps.stages
            .expandQueries(input.query, input.burnedStems, input.sampling)
            .then((r) => r.value)
            .catch(() => [] as string[]),
        );
        for (const expanded of expansions) {
          const retry = yield* Effect.exit(
            crawlOne(resolved, expanded, budget, { userId: input.userId, runId: input.runId, credentials: resolved.credentials }),
          );
          if (retry._tag === "Success") {
            final = { artifacts: retry.value.artifacts, warnings: [...retry.value.warnings, `expanded from "${input.query}"`] };
            break;
          }
        }
      }

      return { sourceId, artifacts: final.artifacts, label: resolved.adapter.label, warnings: final.warnings, failedMessage: null };
    }),
    { concurrency: "unbounded" },
  );

  return outcomes;
});
