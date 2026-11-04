import type { DirectoryAdapter, DirectoryPage, DirectoryRow } from "./registry";
import { registerDirectoryAdapter } from "./registry";

const BASE_URL = "https://www.kemenperin.go.id/direktori-perusahaan";
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";
const PAGE_DELAY_MS = 250;

let lastRequestAt = 0;

async function pace(): Promise<void> {
  const elapsed = Date.now() - lastRequestAt;
  if (lastRequestAt > 0 && elapsed < PAGE_DELAY_MS) await new Promise((resolve) => setTimeout(resolve, PAGE_DELAY_MS - elapsed));
  lastRequestAt = Date.now();
}

export interface KemenperinDirectoryRow extends DirectoryRow {
  kbli: string | null;
}

function stripTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseDirectoryRows(html: string): KemenperinDirectoryRow[] {
  const rows: KemenperinDirectoryRow[] = [];
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
    rows.push({ name, email, phone: phoneMatch?.[1]?.trim() ?? null, kbli, industry: kbli ? `KBLI ${kbli}` : null });
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
  await pace();
  const url = href.startsWith("http") ? href : `https://www.kemenperin.go.id/${href.replace(/^\//, "")}`;
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`directory HTTP ${response.status}`);
  return await response.text();
}

export async function searchKemenperin(input: { name?: string; kbli?: string; limit?: number }): Promise<DirectoryRow[]> {
  const params = new URLSearchParams();
  if (input.name) params.set("nama", input.name);
  if (input.kbli) params.set("kbli", input.kbli);
  const html = await fetchPage(`direktori-perusahaan?${params.toString()}`);
  return parseDirectoryRows(html).slice(0, input.limit ?? 20);
}

export const kemenperinAdapter: DirectoryAdapter = {
  id: "kemenperin",
  label: "Kemenperin direktori perusahaan",
  defaultPageSize: 3,
  async firstPage(): Promise<DirectoryPage> {
    const html = await fetchPage(BASE_URL);
    return { rows: parseDirectoryRows(html), cursor: nextPageHref(html, 1) };
  },
  async nextPage(cursor: string): Promise<DirectoryPage> {
    const html = await fetchPage(cursor);
    return { rows: parseDirectoryRows(html), cursor: nextPageHref(html, Number(new URL(cursor).searchParams.get("hal") ?? 1)) };
  },
};

registerDirectoryAdapter(kemenperinAdapter);
