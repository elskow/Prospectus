import { spawn } from "node:child_process";
import { connect } from "node:net";
import { resolve } from "node:path";

const DEFAULT_PORT = 9710;
const WORKER_ENTRY = resolve(process.cwd(), "workers/google-maps.cjs");

export function portOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
  const { promise, resolve: done } = Promise.withResolvers<boolean>();
  const socket = connect({ host, port });
  const finish = (open: boolean) => {
    socket.destroy();
    done(open);
  };
  socket.once("connect", () => finish(true));
  socket.once("error", () => finish(false));
  return promise;
}

export async function ensureMapsDaemon(): Promise<{ url: string; started: boolean }> {
  const port = Number(process.env.MAPS_DAEMON_PORT ?? DEFAULT_PORT);
  const url = process.env.MAPS_DAEMON_URL || `tcp://127.0.0.1:${port}`;
  if (!process.env.MAPS_DAEMON_URL) process.env.MAPS_DAEMON_URL = url;

  if (process.env.MAPS_DAEMON_AUTOSTART === "false") return { url, started: false };
  if (await portOpen(port)) return { url, started: false };

  const child = spawn("node", [WORKER_ENTRY], {
    env: { ...process.env, MAPS_DAEMON_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  child.unref();

  return { url, started: true };
}
