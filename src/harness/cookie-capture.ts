import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

const WORKER_PATH = resolve(process.cwd(), "workers/cookie-capture.cjs");
const CAPTURE_TIMEOUT_MS = 300_000;

export interface CookieCheck {
  field: string;
  name: string;
  domain: string;
}

export interface CaptureTarget {
  label: string;
  startUrl: string;
  cookieChecks: CookieCheck[];
}

export const CAPTURE_TARGETS: Record<string, CaptureTarget> = {
  "source:linkedin": {
    label: "LinkedIn",
    startUrl: "https://www.linkedin.com/login",
    cookieChecks: [{ field: "liAt", name: "li_at", domain: "linkedin.com" }],
  },
  "source:x": {
    label: "X (Twitter)",
    startUrl: "https://x.com/i/flow/login",
    cookieChecks: [
      { field: "authToken", name: "auth_token", domain: "x.com" },
      { field: "ct0", name: "ct0", domain: "x.com" },
    ],
  },
  "source:threads": {
    label: "Threads (via Instagram login)",
    startUrl: "https://www.instagram.com/accounts/login/",
    cookieChecks: [{ field: "sessionId", name: "sessionid", domain: "instagram.com" }],
  },
};

interface CaptureJob {
  id: string;
  adapterType: string;
  status: "waiting" | "captured" | "failed";
  cookies: Record<string, string> | null;
  error: string | null;
  startedAt: number;
  child: ChildProcessWithoutNullStreams | null;
}

const jobs = new Map<string, CaptureJob>();

function terminateJob(job: CaptureJob) {
  job.child?.kill("SIGTERM");
  job.child = null;
}

export function startCapture(adapterType: string): CaptureJob {
  const existing = [...jobs.values()].find((job) => job.adapterType === adapterType && job.status === "waiting");
  if (existing) return existing;

  const target = CAPTURE_TARGETS[adapterType];
  if (!target) {
    throw new Error(`no capture flow for adapter "${adapterType}"`);
  }

  const child: ChildProcessWithoutNullStreams = spawn("node", [WORKER_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  const job: CaptureJob = {
    id: randomUUID(),
    adapterType,
    status: "waiting",
    cookies: null,
    error: null,
    startedAt: Date.now(),
    child,
  };
  jobs.set(job.id, job);

  let buffer = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newlineIndex: number;

    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;

      try {
        const message = JSON.parse(line) as { id: string; ok: boolean; result?: unknown; error?: string };
        if (message.id === "__ready__") continue;
        if (message.ok && message.result && typeof message.result === "object") {
          job.cookies = message.result as Record<string, string>;
          job.status = "captured";
        } else {
          job.status = "failed";
          job.error = message.error ?? "capture failed";
        }
        terminateJob(job);
      } catch {
        job.status = "failed";
        job.error = "malformed worker output";
        terminateJob(job);
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    console.error(`[cookie-capture:${adapterType}] ${chunk.trim()}`);
  });

  child.on("exit", () => {
    if (job.status === "waiting") {
      job.status = "failed";
      job.error = "capture browser closed before cookies were found";
    }
    job.child = null;
  });

  const payload = JSON.stringify({
    id: "capture",
    method: "capture",
    payload: { startUrl: target.startUrl, cookieChecks: target.cookieChecks, timeoutMs: CAPTURE_TIMEOUT_MS },
  });

  child.stdin.write(payload + "\n");

  setTimeout(() => {
    if (job.status === "waiting") {
      job.status = "failed";
      job.error = "capture-timeout";
      terminateJob(job);
    }
  }, CAPTURE_TIMEOUT_MS + 30_000);

  return job;
}

export function getCaptureStatus(jobId: string): CaptureJob | null {
  const job = jobs.get(jobId);
  if (!job) return null;
  if (job.status !== "waiting" && Date.now() - job.startedAt > 600_000) {
    jobs.delete(jobId);
  }
  return job;
}
