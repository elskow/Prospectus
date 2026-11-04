import type { DirectoryAdapter, DirectoryPage, DirectoryRow } from "./registry";
import { registerDirectoryAdapter } from "./registry";

const BASE_URL = "https://exim.kemendag.go.id/";
const LIST_URL = "https://exim.kemendag.go.id/home/get_eksportir_v2";
const PAGE_SIZE = 100;
const REQUEST_DELAY_MS = 500;
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

interface KemendagTokenCache {
  token: string;
  fetchedAt: number;
}

interface KemendagApiResponse {
  recordsTotal?: number;
  recordsFiltered?: number;
  data?: { nama_eksportir?: string | null; alamat_eksportir?: string | null; email_eksportir?: string | null; no?: number | string | null }[];
}

const tokenCache: KemendagTokenCache = { token: "", fetchedAt: 0 };

let lastRequestAt = 0;

async function pace(): Promise<void> {
  const elapsed = Date.now() - lastRequestAt;
  if (lastRequestAt > 0 && elapsed < REQUEST_DELAY_MS) await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS - elapsed));
  lastRequestAt = Date.now();
}

async function fetchLandingPage(): Promise<string> {
  await pace();
  const response = await fetch(BASE_URL, {
    headers: { "user-agent": USER_AGENT, referer: BASE_URL },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`directory HTTP ${response.status}`);
  return await response.text();
}

async function extractToken(): Promise<string> {
  const html = await fetchLandingPage();
  const match = html.match(/d\.token\s*=\s*"([0-9a-fA-F]+)"/);
  if (!match?.[1]) throw new Error("kemendag: token not found in landing page");
  tokenCache.token = match[1];
  tokenCache.fetchedAt = Date.now();
  return tokenCache.token;
}

async function currentToken(): Promise<string> {
  if (tokenCache.token && Date.now() - tokenCache.fetchedAt < 5 * 60_000) return tokenCache.token;
  return await extractToken();
}

async function fetchListPage(token: string, start: number): Promise<KemendagApiResponse> {
  await pace();
  const body = new URLSearchParams({ draw: "1", start: String(start), length: String(PAGE_SIZE), "search[value]": "", hs: "", token });
  const response = await fetch(LIST_URL, {
    method: "POST",
    headers: {
      "user-agent": USER_AGENT,
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
      referer: BASE_URL,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`directory HTTP ${response.status}`);
  const json = (await response.json()) as KemendagApiResponse;
  if (!json.data || json.data.length === 0) throw new Error("kemendag: empty list response");
  return json;
}

async function fetchListPageWithRetry(start: number): Promise<KemendagApiResponse> {
  try {
    const token = await currentToken();
    return await fetchListPage(token, start);
  } catch {
    const token = await extractToken();
    return await fetchListPage(token, start);
  }
}

function mapRow(entry: NonNullable<KemendagApiResponse["data"]>[number], pageUrl: string): DirectoryRow | null {
  const name = (entry.nama_eksportir ?? "").trim();
  if (!name || name === "-") return null;
  const email = (entry.email_eksportir ?? "").trim();
  return {
    name,
    address: (entry.alamat_eksportir ?? "").trim() || null,
    email: email.includes("@") ? email.toLowerCase() : null,
    country: "Indonesia",
    sourceUrl: pageUrl,
    raw: { no: entry.no ?? null },
  };
}

function encodeCursor(token: string, start: number, recordsTotal: number): string | null {
  if (start >= recordsTotal) return null;
  return Buffer.from(JSON.stringify({ token, start }), "utf8").toString("base64");
}

async function fetchPage(start: number): Promise<DirectoryPage> {
  const json = await fetchListPageWithRetry(start);
  const recordsTotal = json.recordsTotal ?? json.recordsFiltered ?? 0;
  const token = tokenCache.token;
  const rows: DirectoryRow[] = [];
  for (const entry of json.data ?? []) {
    const row = mapRow(entry, BASE_URL);
    if (row) rows.push(row);
  }
  return { rows, cursor: encodeCursor(token, start + PAGE_SIZE, recordsTotal) };
}

export const kemendagEximAdapter: DirectoryAdapter = {
  id: "kemendag-exim",
  label: "Kemendag exporter directory",
  defaultPageSize: 3,
  firstPage(): Promise<DirectoryPage> {
    return fetchPage(0);
  },
  nextPage(cursor: string): Promise<DirectoryPage> {
    const decoded = JSON.parse(Buffer.from(cursor, "base64").toString("utf8")) as { token: string; start: number };
    return fetchPage(decoded.start);
  },
};

registerDirectoryAdapter(kemendagEximAdapter);
