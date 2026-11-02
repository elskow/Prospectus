import { ARTIFACT_SCHEMA_VERSION } from "@src/adapters/source";
import type { CrawlInput, CrawlResult, RawCompanyArtifact } from "@src/adapters/types";
import { FatalSourceError, TransientSourceError } from "@src/harness/errors";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

export interface SocialWorkerRequest {
  id: string;
  method: "ping" | "crawl" | "discover-people" | "discover-company-people" | "search";
  payload?: unknown;
}

export interface SocialWorkerResponse {
  v: number;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  transient?: boolean;
}

export interface SocialWorkerHandle {
  request(method: SocialWorkerRequest["method"], payload?: unknown, timeoutMs?: number): Promise<unknown>;
  stop(): Promise<void>;
}

const REQUEST_TIMEOUT_MS = 120_000;
const READY_TIMEOUT_MS = 30_000;

export type SocialPlatform = "linkedin" | "x" | "threads" | "jobstreet" | "instagram";

export interface DiscoveredPerson {
  name: string;
  title: string | null;
  city: string | null;
  linkedinUrl: string;
  isDecisionMaker: boolean;
}

export interface JobBoardRole {
  title: string;
  company: string | null;
  location: string | null;
}

export interface JobBoardSearchResult {
  board: "jobstreet" | "glints";
  totalResultCount: number;
  firstPageRoles: JobBoardRole[];
  hrRelevantCount: number;
  sourceUrl?: string;
  warnings?: string[];
  schemaVersion?: number;
}

export function socialWorkerPath(platform: SocialPlatform): string {
  return resolve(process.cwd(), `workers/${platform}.cjs`);
}

export function spawnSocialWorker(platform: SocialPlatform, env: Record<string, string>): SocialWorkerHandle {
  const child: ChildProcessWithoutNullStreams = spawn("node", [socialWorkerPath(platform)], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });

  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  const ready = Promise.withResolvers<void>();
  let buffer = "";

  function dispatch(response: SocialWorkerResponse) {
    if (response.id === "__ready__" && response.ok) {
      ready.resolve();
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
        dispatch(JSON.parse(line) as SocialWorkerResponse);
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
      const error = new Error(`${platform} worker exited unexpectedly (code ${code})${stderrTail ? `: ${stderrTail.trim()}` : ""}`);

      (error as Error & { transient?: boolean }).transient = false;

      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }

      pending.clear();
      reject(error);
    });
  });

  function request(method: SocialWorkerRequest["method"], payload?: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    const id = randomUUID();
    const frame: SocialWorkerRequest = { id, method, payload };
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new TransientSourceError(`worker request "${method}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      pending.set(id, { resolve: resolveRequest, reject, timer });
      child.stdin.write(JSON.stringify(frame) + "\n");
    });
  }

  return {
    async request(method, payload, timeoutMs) {
      if (method !== "ping") await ready.promise;

      return Promise.race([request(method, payload, timeoutMs), exited]);
    },
    async stop() {
      child.kill("SIGTERM");
      const exitedOnce = Promise.withResolvers<void>();

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        exitedOnce.resolve();
      }, 3000);

      child.on("exit", () => {
        clearTimeout(timer);
        exitedOnce.resolve();
      });

      await exitedOnce.promise;
    },
  };
}

export class SocialWorkerPool {
  private worker: SocialWorkerHandle | null = null;
  env: Record<string, string>;

  constructor(
    private readonly platform: SocialPlatform,
    env: Record<string, string> = {},
  ) {
    this.env = env;
  }

  private async ensureWorker(): Promise<SocialWorkerHandle> {
    if (!this.worker) {
      this.worker = spawnSocialWorker(this.platform, this.env);
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
      const transient = (error as Error & { transient?: boolean }).transient ?? /timeout|net::|ERR_|429|captcha|unusual traffic|login|auth/i.test(message);

      await this.stop();
      if (transient) {
        throw new TransientSourceError(`${this.platform} crawl failed: ${message}`);
      }

      throw new FatalSourceError(`${this.platform} crawl failed fatally: ${message}`);
    }
  }

  async discoverPeople(companyName: string, city: string | null): Promise<DiscoveredPerson[]> {
    const worker = await this.ensureWorker();
    try {
      const result = (await worker.request("discover-people", { companyName, city })) as {
        people: DiscoveredPerson[];
      };

      return result.people;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const transient = (error as Error & { transient?: boolean }).transient ?? /timeout|net::|ERR_|429|captcha|unusual traffic|login|auth/i.test(message);

      await this.stop();
      if (transient) {
        throw new TransientSourceError(`${this.platform} discover-people failed: ${message}`);
      }

      throw new FatalSourceError(`${this.platform} discover-people failed fatally: ${message}`);
    }
  }

  async discoverCompanyPeople(companyUrl: string, maxResults = 8): Promise<DiscoveredPerson[]> {
    const worker = await this.ensureWorker();
    try {
      const result = (await worker.request("discover-company-people", { companyUrl, maxResults })) as {
        people: DiscoveredPerson[];
      };

      return result.people;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const transient = (error as Error & { transient?: boolean }).transient ?? /timeout|net::|ERR_|429|captcha|unusual traffic|login|auth/i.test(message);

      await this.stop();
      if (transient) {
        throw new TransientSourceError(`${this.platform} discover-company-people failed: ${message}`);
      }

      throw new FatalSourceError(`${this.platform} discover-company-people failed fatally: ${message}`);
    }
  }

  async searchJobs(input: { query: string; location?: string | null }): Promise<JobBoardSearchResult> {
    const worker = await this.ensureWorker();
    try {
      const result = (await worker.request("search", input)) as JobBoardSearchResult;

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const transient = (error as Error & { transient?: boolean }).transient ?? /timeout|net::|ERR_|429|captcha|unusual traffic|login|auth/i.test(message);

      await this.stop();
      if (transient) {
        throw new TransientSourceError(`${this.platform} search failed: ${message}`);
      }

      throw new FatalSourceError(`${this.platform} search failed fatally: ${message}`);
    }
  }

  async stop(): Promise<void> {
    if (this.worker) {
      await this.worker.stop();
      this.worker = null;
    }
  }
}
