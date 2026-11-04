import { eq } from "drizzle-orm";
import { db } from "@src/db";
import { ingestJobs, runs } from "@src/db/schema";
import { ensureSource, persistCandidates } from "@src/harness/persistence";
import type { LeadCandidate } from "@src/harness/schemas";
import { getDirectoryAdapter, listDirectoryAdapters } from "./registry";
import type { DirectoryPage, DirectoryRow } from "./registry";

export interface IngestRunInput {
  adapterId: string;
  campaignId?: string | null;
  pages?: number;
  jobId?: string;
  createdByUserId?: string | null;
  onProgress?: (message: string) => void;
}

export interface IngestRunResult {
  pages: number;
  rows: number;
  withEmail: number;
  newCompanies: number;
  newLeads: number;
  duplicates: number;
  rejected: number;
  flagged: number;
  stoppedReason: string;
}

function rowToCandidate(row: DirectoryRow): LeadCandidate {
  return {
    name: row.name,
    address: row.address ?? null,
    phone: row.phone ?? null,
    website: row.website ?? null,
    city: row.city ?? null,
    province: row.province ?? null,
    country: row.country ?? null,
    category: row.industry ?? null,
    contacts: row.email ? [{ name: null, title: null, email: row.email, phone: null, linkedinUrl: null, isDecisionMaker: null }] : null,
    sourceUrl: row.sourceUrl ?? null,
    raw: row.raw ?? null,
  };
}

export async function runDirectoryIngest(input: IngestRunInput): Promise<IngestRunResult> {
  const emit = input.onProgress ?? (() => {});
  const adapter = getDirectoryAdapter(input.adapterId);
  if (!adapter)
    throw new Error(
      `unknown directory adapter: ${input.adapterId}. known: ${listDirectoryAdapters()
        .map((a) => a.id)
        .join(", ")}`,
    );

  let ownsJob = false;
  let jobId = input.jobId ?? null;
  if (!jobId) {
    const inserted = await db
      .insert(ingestJobs)
      .values({
        campaignId: input.campaignId ?? null,
        source: input.adapterId,
        status: "queued",
        pagesTarget: input.pages ?? adapter.defaultPageSize,
      })
      .returning({ id: ingestJobs.id });
    const created = inserted[0];
    if (!created) throw new Error("failed to create the ingest job");
    jobId = created.id;
    ownsJob = true;
  }

  const updateJob = async (patch: Partial<typeof ingestJobs.$inferInsert>): Promise<void> => {
    if (!jobId) return;
    await db
      .update(ingestJobs)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(ingestJobs.id, jobId));
  };

  await updateJob({ status: "running" });

  let runId: string | null = null;
  if (input.campaignId) {
    const insertedRun = await db
      .insert(runs)
      .values({
        campaignId: input.campaignId,
        status: "succeeded",
        trigger: "manual",
        finishedAt: new Date(),
        result: { status: "succeeded", reason: `ingest:${input.adapterId}`, turnsUsed: 0, newReadyLeads: 0, totalReadyLeads: 0 },
      })
      .returning({ id: runs.id });
    const run = insertedRun[0];
    if (!run) throw new Error("failed to record the ingest run");
    runId = run.id;
  }

  const result: IngestRunResult = {
    pages: 0,
    rows: 0,
    withEmail: 0,
    newCompanies: 0,
    newLeads: 0,
    duplicates: 0,
    rejected: 0,
    flagged: 0,
    stoppedReason: "page budget reached",
  };

  try {
    const sourceId = await ensureSource(`source:${input.adapterId}`, "direktori perusahaan");
    const budget = input.pages ?? adapter.defaultPageSize;
    let cursor: string | null = null;
    let page = 1;
    let pageResult: DirectoryPage;

    while (result.pages < budget) {
      pageResult = cursor === null ? await adapter.firstPage() : await adapter.nextPage(cursor);
      cursor = pageResult.cursor;
      if (pageResult.rows.length === 0) {
        result.stoppedReason = "no parseable rows";
        break;
      }
      const candidates = pageResult.rows.map(rowToCandidate);
      const persisted = await persistCandidates({ campaignId: input.campaignId ?? null, runId, sourceId, candidates });
      result.pages += 1;
      result.rows += pageResult.rows.length;
      result.withEmail += pageResult.rows.filter((row) => row.email).length;
      result.newCompanies += persisted.newCompanies;
      result.newLeads += persisted.newLeads;
      result.duplicates += persisted.duplicates;
      result.rejected += persisted.rejected ?? 0;
      result.flagged += persisted.flagged ?? 0;
      emit(`page ${page}: ${pageResult.rows.length} rows (${persisted.newLeads} new leads, ${persisted.duplicates} duplicates)`);

      await updateJob({
        pagesDone: result.pages,
        rowsSeen: result.rows,
        rowsWithEmail: result.withEmail,
        newCompanies: result.newCompanies,
        newLeads: result.newLeads,
        rejected: result.rejected,
        flagged: result.flagged,
      });

      if (!cursor) {
        result.stoppedReason = "last page";
        break;
      }
      page += 1;
    }

    if (input.campaignId && runId) {
      await db
        .update(runs)
        .set({ result: { status: "succeeded", reason: `ingest:${input.adapterId} (${result.rows} rows)`, turnsUsed: 0, newReadyLeads: 0, totalReadyLeads: 0 } })
        .where(eq(runs.id, runId));
    }
    await updateJob({
      status: "succeeded",
      pagesDone: result.pages,
      rowsSeen: result.rows,
      rowsWithEmail: result.withEmail,
      newCompanies: result.newCompanies,
      newLeads: result.newLeads,
      rejected: result.rejected,
      flagged: result.flagged,
      finishedAt: new Date(),
    });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateJob({ status: "failed", error: message, finishedAt: new Date() }).catch(() => {});
    if (!ownsJob && jobId) {
      await db
        .update(ingestJobs)
        .set({ status: "failed", error: message, finishedAt: new Date(), updatedAt: new Date() })
        .where(eq(ingestJobs.id, jobId))
        .catch(() => {});
    }
    throw error;
  }
}
