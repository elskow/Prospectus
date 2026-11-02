import { SpanType } from "@mastra/core/observability";
import type { Span } from "@mastra/core/observability";
import { mastra } from "@src/mastra";

export interface HarnessTracer {
  traceId: string | null;
  span<T>(name: string, fn: () => Promise<T>, detail?: (result: T) => Record<string, unknown>): Promise<T>;
  flush(): Promise<void>;
}

export function createHarnessTracer(runId: string, campaignId: string, traceIdHex: string | null): HarnessTracer {
  const instance = mastra.observability.getDefaultInstance();
  let root: Span<typeof SpanType.GENERIC> | null = null;

  if (instance && traceIdHex) {
    try {
      root = instance.startSpan({
        type: SpanType.GENERIC,
        name: `goal-loop run ${runId.slice(0, 8)}`,
        attributes: {},
        metadata: { runId, campaignId },
        tracingOptions: { traceId: traceIdHex },
      });
    } catch {
      root = null;
    }
  }

  return {
    traceId: root ? traceIdHex : null,
    async span<T>(name: string, fn: () => Promise<T>, detail?: (result: T) => Record<string, unknown>): Promise<T> {
      if (!root) return fn();
      let child: Span<typeof SpanType.GENERIC>;
      try {
        child = root.createChildSpan({ type: SpanType.GENERIC, name, attributes: {}, metadata: { runId, campaignId } });
      } catch {
        return fn();
      }
      try {
        const result = await fn();
        child.end({ output: detail ? { result: detail(result) } : undefined });
        return result;
      } catch (error) {
        child.error({ error: error instanceof Error ? error : new Error(String(error)), endSpan: true });
        throw error;
      }
    },
    async flush(): Promise<void> {
      try {
        await instance?.flush();
      } catch {}
    },
  };
}
