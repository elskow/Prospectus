import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { SpanKind, SpanStatusCode, TraceFlags } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { TracingEventType } from "@mastra/core/observability";
import type { ObservabilityExporter, TracingEvent, AnyExportedSpan } from "@mastra/core/observability";

const TRACE_ID_HEX = 32;

const SPAN_ID_HEX = 16;

const MAX_TEXT = 8192;

function toHex(id: string, width: number): string {
  const clean = id.replace(/[^0-9a-fA-F]/g, "");
  return clean.length >= width ? clean.slice(0, width) : clean.padStart(width, "0");
}

function toHrTime(date: Date | undefined): [number, number] {
  const ms = (date ?? new Date()).getTime();
  return [Math.floor(ms / 1000), (ms % 1000) * 1_000_000];
}

function preview(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (!text) return undefined;
    return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…[truncated]` : text;
  } catch {
    return "[unserializable]";
  }
}

function mastraSpanAttributes(span: AnyExportedSpan): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = {
    "mastra.span.type": String(span.type),
    "mastra.is.event": Boolean(span.isEvent),
  };
  if (span.entityType) attributes["mastra.entity.type"] = span.entityType;
  if (span.entityId) attributes["mastra.entity.id"] = span.entityId;
  if (span.entityName) attributes["mastra.entity.name"] = span.entityName;
  if ("isRootSpan" in span) {
    attributes["mastra.is.root"] = Boolean(span.isRootSpan);
  }
  const attrs = span.attributes as Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      attributes[`mastra.attr.${key}`] = value;
    } else {
      attributes[`mastra.attr.${key}`] = preview(value) ?? "";
    }
  }
  const inputPreview = preview(span.input);
  if (inputPreview !== undefined) attributes["mastra.input"] = inputPreview;
  const outputPreview = preview(span.output);
  if (outputPreview !== undefined) attributes["mastra.output"] = outputPreview;
  if (span.errorInfo) {
    attributes["error.type"] = span.errorInfo.name ?? "Error";
    attributes["error.message"] = span.errorInfo.message;
    if (span.errorInfo.domain) attributes["mastra.error.domain"] = span.errorInfo.domain;
  }
  for (const [key, value] of Object.entries(span.metadata ?? {})) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      attributes[`mastra.meta.${key}`] = value;
    } else {
      attributes[`mastra.meta.${key}`] = preview(value) ?? "";
    }
  }
  return attributes;
}

function mastraSpanToReadableSpan(span: AnyExportedSpan, serviceName: string, scopeName: string, scopeVersion: string): ReadableSpan {
  const start = toHrTime(span.startTime);
  const end = toHrTime(span.endTime ?? span.startTime);
  const hasError = Boolean(span.errorInfo);
  return {
    name: span.name.slice(0, 512),
    kind: SpanKind.INTERNAL,
    spanContext: () => ({
      traceId: toHex(span.traceId, TRACE_ID_HEX),
      spanId: toHex(span.id, SPAN_ID_HEX),
      traceFlags: TraceFlags.SAMPLED,
      isRemote: false,
    }),
    parentSpanId: span.parentSpanId ? toHex(span.parentSpanId, SPAN_ID_HEX) : undefined,
    startTime: start,
    endTime: end,
    duration: [end[0] - start[0], end[1] - start[1]],
    ended: true,
    status: hasError ? { code: SpanStatusCode.ERROR, message: span.errorInfo?.message } : { code: SpanStatusCode.OK },
    attributes: mastraSpanAttributes(span),
    links: [],
    events: [],
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
    resource: { attributes: { "service.name": serviceName } },
    instrumentationScope: { name: scopeName, version: scopeVersion },
  } as unknown as ReadableSpan;
}

export class OtlpHttpExporter implements ObservabilityExporter {
  name = "otlp-http";
  private delegate: OTLPTraceExporter;
  private serviceName: string;
  private scopeName: string;
  private scopeVersion: string;
  private failures = 0;

  constructor(serviceName: string, endpoint: string, headers?: Record<string, string>) {
    this.serviceName = serviceName;
    this.scopeName = "@mastra/observability";
    this.scopeVersion = "1.21.0";
    this.delegate = new OTLPTraceExporter({ url: endpoint, headers: headers ?? {} });
  }

  init(): void {}

  exportTracingEvent(event: TracingEvent): Promise<void> {
    if (event.type !== TracingEventType.SPAN_ENDED) return Promise.resolve();
    if (event.exportedSpan.isEvent) return Promise.resolve();
    const readable = mastraSpanToReadableSpan(event.exportedSpan, this.serviceName, this.scopeName, this.scopeVersion);
    return new Promise<void>((resolve) => {
      this.delegate.export([readable], (result) => {
        if (result.code === 0) {
          this.failures = 0;
        } else {
          this.failures += 1;
          if (this.failures <= 3) {
            console.error(`[otel-exporter] export failed: ${result.error?.message ?? result.code}`);
          }
        }
        resolve();
      });
    });
  }

  async flush(): Promise<void> {}

  async shutdown(): Promise<void> {
    await this.delegate.shutdown();
  }
}
