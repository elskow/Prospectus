import { connect } from "node:net";
import { defineEventHandler } from "h3";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@src/db";
import { runs } from "@src/db/schema";

const DAEMON_PORT = Number(process.env.MAPS_DAEMON_PORT ?? 9710);

function portOpen(port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = connect({ host: "127.0.0.1", port });
  socket.once("connect", () => {
    socket.destroy();
    resolve(true);
  });
  socket.once("error", () => resolve(false));
  return promise;
}

export default defineEventHandler(async () => {
  const startedAt = Date.now();

  let database = false;
  let queued = 0;
  let running = 0;
  let lastRunStatus: string | null = null;
  try {
    await db.execute(sql`select 1`);
    database = true;
    const [counts] = await db
      .select({
        queued: sql<number>`count(*) filter (where ${runs.status} = 'queued')::int`,
        running: sql<number>`count(*) filter (where ${runs.status} = 'running')::int`,
      })
      .from(runs);
    queued = Number(counts?.queued ?? 0);
    running = Number(counts?.running ?? 0);
    const [latest] = await db
      .select({ status: runs.status })
      .from(runs)
      .where(inArray(runs.status, ["running", "queued"]))
      .orderBy(desc(runs.startedAt))
      .limit(1);
    lastRunStatus = latest?.status ?? null;
  } catch {
    database = false;
  }

  const scraperDaemon = await portOpen(DAEMON_PORT).catch(() => false);
  const healthy = database && scraperDaemon;

  return {
    status: healthy ? "ok" : "degraded",
    checks: { database, scraperDaemon },
    runs: { queued, running, lastActive: lastRunStatus },
    latencyMs: Date.now() - startedAt,
    at: new Date().toISOString(),
  };
});
