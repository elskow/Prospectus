import { eq } from "drizzle-orm";
import { db } from "@src/db";
import { ingestJobs, runs } from "@src/db/schema";
import { ensureSource, persistCandidates } from "@src/harness/persistence";
import type { LeadCandidate } from "@src/harness/schemas";

const BASE_URL = "https://www.kemenperin.go.id/direktori-perusahaan";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";
const PAGE_DELAY_MS = 250;

export interface DirectoryRow {
  name: string;
  email: string | null;
  phone: string | null;
  kbli: string | null;
}

export interface IngestResult {
  pages: number;
  rows: number;
  withEmail: number;
  newCompanies: number;
  newLeads: number;
  duplicates: number;
  stoppedReason: string;
}

function stripTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseDirectoryRows(html: string): DirectoryRow[] {
  const rows: DirectoryRow[] = [];
  for (const tableRow of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? []) {
    const cells = [...tableRow.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((match) => stripTags(match[1] ?? ""));
    if (cells.length < 3) continue;
    const text = cells[1] ?? "";
    const emailMatch = text.match(/Email\s*:\s*([^\s,;]+@[^\s,;]+)/i);
    const email = emailMatch?.[1]?.toLowerCase() ?? null;
    const beforeEmail = emailMatch ? text.slice(0, emailMatch.index) : text;
    const phoneMatch = beforeEmail.match(/Telp\.?\s*:?\s*([0-9()+\-\s]{6,})/i);
    const name = beforeEmail.replace(/Telp\.?.*$/i, "").trim();
    if (!name || name.length < 2) continue;
    const kbli = /^\d{4,5}$/.test(cells[2] ?? "") ? (cells[2] ?? null) : null;
    rows.push({ name, email, phone: phoneMatch?.[1]?.trim() ?? null, kbli });
  }
  return rows;
}

function nextPageHref(html: string, currentPage: number): string | null {
  let best: { page: number; href: string } | null = null;
  for (const match of html.matchAll(/<a[^>]*href="([^"]*hal=[^"]*)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const href = match[1] ?? "";
    const label = stripTags(match[2] ?? "");
    const numeric = Number.parseInt(label.replace(/[^0-9].*$/, ""), 10);
    if (!Number.isFinite(numeric) || numeric <= currentPage) continue;
    if (best && best.page <= numeric) continue;
    best = { page: numeric, href };
  }
  return best?.href ?? null;
}

async function fetchPage(href: string): Promise<string> {
  const url = href.startsWith("http") ? href : `https://www.kemenperin.go.id/${href.replace(/^\//, "")}`;
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`directory HTTP ${response.status}`);
  return await response.text();
}

function toCandidate(row: DirectoryRow): LeadCandidate {
  return {
    name: row.name,
    phone: row.phone,
    category: row.kbli ? `KBLI ${row.kbli}` : null,
    contacts: row.email ? [{ name: null, title: null, email: row.email, phone: null, linkedinUrl: null, isDecisionMaker: null }] : null,
    sourceUrl: BASE_URL,
  };
}

export async function searchKemenperin(input: { name?: string; kbli?: string; limit?: number }): Promise<DirectoryRow[]> {
  const params = new URLSearchParams();
  if (input.name) params.set("nama", input.name);
  if (input.kbli) params.set("kbli", input.kbli);
  const html = await fetchPage(`direktori-perusahaan?${params.toString()}`);
  return parseDirectoryRows(html).slice(0, input.limit ?? 20);
}

export async function ingestKemenperin(input: {
  campaignId: string;
  pages: number;
  jobId?: string;
  onProgress?: (message: string) => void;
}): Promise<IngestResult> {
  const emit = input.onProgress ?? (() => {});
  const updateJob = async (patch: Partial<typeof ingestJobs.$inferInsert>): Promise<void> => {
    if (!input.jobId) return;
    await db
      .update(ingestJobs)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(ingestJobs.id, input.jobId));
  };
  await updateJob({ status: "running" });
  const insertedRun = await db
    .insert(runs)
    .values({
      campaignId: input.campaignId,
      status: "succeeded",
      trigger: "manual",
      finishedAt: new Date(),
      result: { status: "succeeded", reason: "ingest:kemenperin", turnsUsed: 0, newReadyLeads: 0, totalReadyLeads: 0 },
    })
    .returning({ id: runs.id });
  const run = insertedRun[0];
  if (!run) throw new Error("failed to record the ingest run");

  const sourceId = await ensureSource("source:kemenperin", "direktori perusahaan");
  const result: IngestResult = {
    pages: 0,
    rows: 0,
    withEmail: 0,
    newCompanies: 0,
    newLeads: 0,
    duplicates: 0,
    stoppedReason: "page budget reached",
  };

  let href: string | null = BASE_URL;
  let page = 1;
  while (href && result.pages < input.pages) {
    const html = await fetchPage(href);
    const rows = parseDirectoryRows(html);
    if (rows.length === 0) {
      result.stoppedReason = "no parseable rows";
      break;
    }
    const candidates = rows.map(toCandidate);
    const persisted = await persistCandidates({ campaignId: input.campaignId, runId: run.id, sourceId, candidates });
    result.pages += 1;
    result.rows += rows.length;
    result.withEmail += rows.filter((row) => row.email).length;
    result.newCompanies += persisted.newCompanies;
    result.newLeads += persisted.newLeads;
    result.duplicates += persisted.duplicates;
    emit(`page ${page}: ${rows.length} rows (${persisted.newLeads} new leads, ${persisted.duplicates} duplicates)`);
    await updateJob({
      pagesDone: result.pages,
      rowsSeen: result.rows,
      rowsWithEmail: result.withEmail,
      newCompanies: result.newCompanies,
      newLeads: result.newLeads,
    });

    href = nextPageHref(html, page);
    page += 1;
    if (!href) result.stoppedReason = "last page";
    await new Promise((resolve) => setTimeout(resolve, PAGE_DELAY_MS));
  }

  await db
    .update(runs)
    .set({ result: { status: "succeeded", reason: `ingest:kemenperin (${result.rows} rows)`, turnsUsed: 0, newReadyLeads: 0, totalReadyLeads: 0 } })
    .where(eq(runs.id, run.id));
  await updateJob({
    status: "succeeded",
    pagesDone: result.pages,
    rowsSeen: result.rows,
    rowsWithEmail: result.withEmail,
    newCompanies: result.newCompanies,
    newLeads: result.newLeads,
    finishedAt: new Date(),
  });
  return result;
}
