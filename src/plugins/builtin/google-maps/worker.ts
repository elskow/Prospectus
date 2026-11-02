import { ARTIFACT_SCHEMA_VERSION } from "@src/adapters/source";
import type { CrawlInput, CrawlResult, RawCompanyArtifact } from "@src/adapters/types";
import { FatalSourceError, TransientSourceError } from "@src/harness/errors";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

export const MAPS_SOURCE_TYPE = "source:google-maps";

export interface WorkerRequest {
  id: string;
  method: "ping" | "crawl" | "resolve-website";
  payload?: unknown;
}

export interface WorkerResponse {
  v: number;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  transient?: boolean;
}

export interface WorkerHandle {
  request(method: WorkerRequest["method"], payload?: unknown, timeoutMs?: number): Promise<unknown>;
  stop(): Promise<void>;
}

const WORKER_PATH = resolve(process.cwd(), "workers/google-maps.cjs");
const REQUEST_TIMEOUT_MS = Number(process.env.MAPS_REQUEST_TIMEOUT_MS ?? 45_000);
const READY_TIMEOUT_MS = 30_000;

function connectMapsDaemon(url: string, env: Record<string, string>): WorkerHandle {
  const [host, portRaw] = url.replace(/^tcp:\/\//, "").split(":");
  const port = Number(portRaw);
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let buffer = "";
  let socket: Socket | null = null;

  function dispatch(response: WorkerResponse) {
    const entry = pending.get(response.id);
    if (!entry) return;
    pending.delete(response.id);
    clearTimeout(entry.timer);
    if (response.ok) entry.resolve(response.result);
    else {
      const error = new Error(response.error ?? "worker error");
      (error as Error & { transient?: boolean }).transient = response.transient ?? false;
      entry.reject(error);
    }
  }

  function ensureSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (socket && !socket.destroyed) {
        resolve();
        return;
      }
      const next = connect({ host, port });
      next.setEncoding("utf8");
      next.once("connect", () => {
        socket = next;
        resolve();
      });
      next.once("error", (error) => {
        reject(new TransientSourceError(`maps daemon unreachable at ${url}: ${error.message}`));
      });
      next.on("data", (chunk: string) => {
        buffer += chunk;
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index).trim();
          buffer = buffer.slice(index + 1);
          if (!line) continue;
          try {
            dispatch(JSON.parse(line) as WorkerResponse);
          } catch {
            continue;
          }
        }
      });
      next.on("close", () => {
        const error = new TransientSourceError(`maps daemon connection closed at ${url}`);
        (error as Error & { transient?: boolean }).transient = true;
        for (const [, entry] of pending) {
          clearTimeout(entry.timer);
          entry.reject(error);
        }
        pending.clear();
        socket = null;
      });
    });
  }

  async function request(method: WorkerRequest["method"], payload?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    await ensureSocket();
    const id = randomUUID();
    const frame: WorkerRequest = {
      id,
      method,
      payload: { ...(payload as Record<string, unknown> | undefined), proxyUrl: env.SCRAPE_PROXY_URL ?? process.env.SCRAPE_PROXY_URL ?? "" },
    };
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new TransientSourceError(`maps daemon request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket?.write(JSON.stringify(frame) + "\n");
    });
  }

  return {
    request,
    async stop() {
      socket?.destroy();
      socket = null;
    },
  };
}

function daemonReachable(url: string): Promise<boolean> {
  const [host, portRaw] = url.replace(/^tcp:\/\//, "").split(":");
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = connect({ host, port: Number(portRaw) });
  socket.once("connect", () => {
    socket.destroy();
    resolve(true);
  });
  socket.once("error", () => resolve(false));
  return promise;
}

export async function spawnMapsWorker(env: Record<string, string>): Promise<WorkerHandle> {
  const configured = env.MAPS_DAEMON_URL ?? process.env.MAPS_DAEMON_URL ?? "";
  if (configured) return connectMapsDaemon(configured, env);

  const fallbackUrl = `tcp://127.0.0.1:${env.MAPS_DAEMON_PORT ?? process.env.MAPS_DAEMON_PORT ?? "9710"}`;
  if (await daemonReachable(fallbackUrl)) return connectMapsDaemon(fallbackUrl, env);

  const child: ChildProcessWithoutNullStreams = spawn("node", [WORKER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });

  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  let readyResolve: (() => void) | null = null;
  const readyPromise = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  let buffer = "";

  function dispatch(response: WorkerResponse) {
    if (response.id === "__ready__" && response.ok) {
      readyResolve?.();
      return;
    }

    const entry = pending.get(response.id);

    if (!entry) return;

    pending.delete(response.id);
    clearTimeout(entry.timer);

    if (response.ok) {
      entry.resolve(response.result);
    } else {
      const error = new Error(response.error ?? "worker error");

      (error as Error & { transient?: boolean }).transient = response.transient ?? false;
      entry.reject(error);
    }
  }

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (!line) continue;
      try {
        dispatch(JSON.parse(line) as WorkerResponse);
      } catch {
        child.kill("SIGTERM");
      }
    }
  });

  child.stderr.setEncoding("utf8");
  let stderrTail = "";
  child.stderr.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-4000);
  });

  const exited = new Promise<never>((_, reject) => {
    child.on("exit", (code) => {
      const error = new Error(`maps worker exited unexpectedly (code ${code})${stderrTail ? `: ${stderrTail.trim()}` : ""}`);

      (error as Error & { transient?: boolean }).transient = false;

      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }

      pending.clear();
      reject(error);
    });
  });

  function request(method: WorkerRequest["method"], payload?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const id = randomUUID();
    const frame: WorkerRequest = { id, method, payload };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new TransientSourceError(`worker request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify(frame) + "\n");
    });
  }

  return {
    async request(method, payload, timeoutMs) {
      if (method !== "ping") await readyPromise;

      return Promise.race([request(method, payload, timeoutMs), exited]);
    },
    async stop() {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 3000);

        child.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

export class MapsWorkerPool {
  private worker: WorkerHandle | null = null;
  env: Record<string, string>;

  constructor(env: Record<string, string> = {}) {
    this.env = env;
  }

  private async ensureWorker(): Promise<WorkerHandle> {
    if (!this.worker) {
      this.worker = await spawnMapsWorker(this.env);
      await this.worker.request("ping", undefined, READY_TIMEOUT_MS);
    }

    return this.worker;
  }

  async crawl(input: CrawlInput): Promise<CrawlResult> {
    const worker = await this.ensureWorker();
    try {
      const result = (await worker.request("crawl", input)) as {
        query: string;
        artifacts: RawCompanyArtifact[];
        sourceUrl?: string;
        warnings: string[];
        schemaVersion?: number;
      };

      return { ...result, schemaVersion: ARTIFACT_SCHEMA_VERSION };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const transient = (error as Error & { transient?: boolean }).transient ?? /timeout|net::|ERR_|429|captcha|unusual traffic/i.test(message);

      await this.stop();
      if (transient) {
        throw new TransientSourceError(`google maps crawl failed: ${message}`);
      }

      throw new FatalSourceError(`google maps crawl failed fatally: ${message}`);
    }
  }

  async resolveWebsite(placeUrl: string): Promise<{ website: string | null; address: string | null; rating: number | null; reviewCount: number | null }> {
    const worker = await this.ensureWorker();
    try {
      return (await worker.request("resolve-website", { placeUrl }, 45_000)) as {
        website: string | null;
        address: string | null;
        rating: number | null;
        reviewCount: number | null;
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new TransientSourceError(`google maps place lookup failed: ${message}`);
    }
  }

  async stop(): Promise<void> {
    if (this.worker) {
      await this.worker.stop();
      this.worker = null;
    }
  }
}

const pool = new MapsWorkerPool();

export function setMapsWorkerEnv(env: Record<string, string>): void {
  pool.env = env;
}

export function crawlMaps(input: CrawlInput): Promise<CrawlResult> {
  return pool.crawl(input);
}

export function resolveMapsWebsite(
  placeUrl: string,
): Promise<{ website: string | null; address: string | null; rating: number | null; reviewCount: number | null }> {
  return pool.resolveWebsite(placeUrl);
}
