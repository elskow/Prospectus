import { and, desc, eq, sql } from "drizzle-orm";
import { spawn } from "node:child_process";
import { z } from "zod";
import { db } from "@src/db";
import { ingestJobs } from "@src/db/schema";
import { searchKemenperin } from "@src/harness/ingest/kemenperin";
import { campaignNotFound, invalidArguments, ToolError } from "../errors";
import { campaignFor, resolveUserId, spawnWorker, type ToolDefinition } from "./shared";

export async function runDirectoryTools(): Promise<ToolDefinition[]> {
  return [
    {
      name: "search_directory",
      description:
        "Search an official company directory by name or KBLI and return matching rows (name, phone, email, KBLI, country). Use it for targeted lookups; for bulk, use start_ingest.",
      schema: z.object({
        source: z.enum(["kemenperin"]).optional(),
        name: z.string().max(120).optional(),
        kbli: z.string().max(10).optional(),
        limit: z.number().int().min(1).max(80).optional(),
      }),
      handler: async (input) => {
        const parsed = z
          .object({
            source: z.enum(["kemenperin"]).optional(),
            name: z.string().max(120).optional(),
            kbli: z.string().max(10).optional(),
            limit: z.number().int().min(1).max(80).optional(),
          })
          .parse(input);
        if (!parsed.name && !parsed.kbli) throw invalidArguments("pass name or kbli");
        const rows = await searchKemenperin({ name: parsed.name, kbli: parsed.kbli, limit: parsed.limit });
        return { source: "kemenperin", matched: rows.length, rows: rows.map((row) => ({ ...row, country: "Indonesia" })) };
      },
    },
    {
      name: "start_ingest",
      description:
        "Start a background directory ingest (paginated walk) into a campaign. Returns a jobId immediately; poll ingest_status. Kemenperin carries published emails for ~30k companies.",
      schema: z.object({
        campaignId: z.string().uuid().optional(),
        source: z.enum(["kemenperin"]).optional(),
        pages: z.number().int().min(1).max(2000).optional(),
      }),
      handler: async (input) => {
        const parsed = z
          .object({ campaignId: z.string().uuid().optional(), source: z.enum(["kemenperin"]).optional(), pages: z.number().int().min(1).max(2000).optional() })
          .parse(input);
        const userId = await resolveUserId();
        const campaign = await campaignFor(userId, parsed.campaignId);
        const pages = parsed.pages ?? 50;
        const source = parsed.source ?? "kemenperin";

        const [running] = await db
          .select({ id: ingestJobs.id, pagesTarget: ingestJobs.pagesTarget, pagesDone: ingestJobs.pagesDone })
          .from(ingestJobs)
          .where(and(eq(ingestJobs.campaignId, campaign.id), eq(ingestJobs.source, source), sql`${ingestJobs.status} in ('queued', 'running')`))
          .orderBy(desc(ingestJobs.createdAt))
          .limit(1);
        if (running) {
          return {
            campaignId: campaign.id,
            jobId: running.id,
            source,
            pagesTarget: running.pagesTarget,
            status: "already-running",
            note: `an ingest is already active for this campaign (${running.pagesDone}/${running.pagesTarget} pages)`,
          };
        }

        const inserted = await db.insert(ingestJobs).values({ campaignId: campaign.id, source, pagesTarget: pages }).returning({ id: ingestJobs.id });
        const job = inserted[0];
        if (!job) throw new ToolError("INGEST_QUEUE_FAILED", "failed to create the ingest job row; retry start_ingest");

        const args = ["scripts/ingest-directory.ts", source, String(pages), job.id];
        if (campaign.id) args.push("--campaign", campaign.id);
        const child = spawn(process.env.BUN_BIN ?? "bun", args, {
          cwd: process.cwd(),
          env: { ...process.env },
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        });
        child.stdout?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
        child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
        child.unref();

        return { campaignId: campaign.id, jobId: job.id, source, pagesTarget: pages, status: "queued" };
      },
    },
    {
      name: "ingest_status",
      description:
        "Status of directory ingests: pages done, rows seen, emails, new companies/leads, and any error. Pass jobId for one job, or omit for recent jobs.",
      schema: z.object({ jobId: z.string().uuid().optional(), limit: z.number().int().min(1).max(20).optional() }),
      handler: async (input) => {
        const parsed = z.object({ jobId: z.string().uuid().optional(), limit: z.number().int().min(1).max(20).optional() }).parse(input);
        const rows = await db
          .select()
          .from(ingestJobs)
          .where(parsed.jobId ? eq(ingestJobs.id, parsed.jobId) : undefined)
          .orderBy(desc(ingestJobs.createdAt))
          .limit(parsed.limit ?? 5);
        return {
          jobs: rows.map((row) => ({
            jobId: row.id,
            campaignId: row.campaignId,
            source: row.source,
            status: row.status,
            pages: `${row.pagesDone}/${row.pagesTarget}`,
            rowsSeen: row.rowsSeen,
            rowsWithEmail: row.rowsWithEmail,
            newCompanies: row.newCompanies,
            newLeads: row.newLeads,
            error: row.error,
            startedAt: row.createdAt,
            finishedAt: row.finishedAt,
          })),
        };
      },
    },
  ];
}
