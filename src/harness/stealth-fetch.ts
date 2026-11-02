import { spawn } from "node:child_process";
import { resolve } from "node:path";

interface StealthPage {
  status: number;
  html: string | null;
}

interface WorkerResult {
  ok: boolean;
  status?: number;
  html?: string;
  error?: string;
}

function runWorker(url: string, timeoutMs: number): Promise<WorkerResult> {
  const { promise, resolve: finishPromise } = Promise.withResolvers<WorkerResult>();
  const workerPath = resolve(process.cwd(), "workers/stealth-fetch.cjs");
  const child = spawn("node", [workerPath, JSON.stringify({ url, timeoutMs })], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  let buffer = "";
  let settled = false;

  const finish = (result: WorkerResult) => {
    if (settled) return;
    settled = true;
    finishPromise(result);
  };

  const timer = setTimeout(() => finish({ ok: false, error: "worker timeout" }), timeoutMs + 15_000);

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;
      clearTimeout(timer);
      try {
        finish(JSON.parse(line) as WorkerResult);
      } catch {
        finish({ ok: false, error: "malformed worker output" });
      }
    }
  });

  child.on("error", (error) => {
    clearTimeout(timer);
    finish({ ok: false, error: String(error) });
  });
  child.on("exit", () => {
    clearTimeout(timer);
    finish({ ok: false, error: "worker exited without result" });
  });

  return promise;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function patchrightStealthFetch(url: string, opts?: { timeoutMs?: number }): Promise<StealthPage> {
  try {
    const result = await runWorker(url, opts?.timeoutMs ?? 25_000);
    if (!result.ok || typeof result.html !== "string") {
      return { status: 0, html: null };
    }
    return { status: result.status ?? 0, html: result.html };
  } catch {
    return { status: 0, html: null };
  }
}
