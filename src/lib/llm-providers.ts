import { asc, eq } from "drizzle-orm";
import { db } from "@src/db";
import { llmProviders } from "@src/db/schema";
import { open, seal } from "@src/lib/crypto";

export const PROVIDER_KINDS = ["9router", "openai-compatible"] as const;

export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export interface ProviderInput {
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface ProviderView {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  enabled: boolean;
  keyHint: string;
  headerNames: string[];
  createdAt: string;
}

export interface ResolvedProvider {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  headers: Record<string, string>;
}

interface SealedPayload {
  apiKey: string;
}

const resolvedCache = new Map<string, { value: ResolvedProvider; expiresAt: number }>();
const CACHE_TTL_MS = 10_000;

export function maskKey(key: string): string {
  if (key.length <= 8) return "…";
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function invalidateProviderCache(): void {
  resolvedCache.clear();
}

function isKind(value: string): value is ProviderKind {
  return (PROVIDER_KINDS as readonly string[]).includes(value);
}

async function decryptKey(sealed: string): Promise<string> {
  const payload = await open<SealedPayload>(sealed);
  return payload.apiKey;
}

function toView(row: typeof llmProviders.$inferSelect, apiKey: string): ProviderView {
  return {
    id: row.id,
    label: row.label,
    kind: isKind(row.kind) ? row.kind : "openai-compatible",
    baseUrl: row.baseUrl,
    enabled: row.enabled,
    keyHint: maskKey(apiKey),
    headerNames: Object.keys(row.extraHeaders ?? {}),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listProviders(): Promise<ProviderView[]> {
  const rows = await db.select().from(llmProviders).orderBy(asc(llmProviders.createdAt));
  return Promise.all(rows.map(async (row) => toView(row, await decryptKey(row.apiKeySealed))));
}

export async function addProvider(input: ProviderInput): Promise<ProviderView> {
  const label = input.label.trim();
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const apiKey = input.apiKey.trim();
  const headers = Object.fromEntries(Object.entries(input.headers ?? {}).map(([name, value]) => [name.trim().toLowerCase(), String(value).trim()]));

  if (!label) throw new Error("provider label is required");
  if (!isKind(input.kind)) throw new Error(`provider kind must be one of: ${PROVIDER_KINDS.join(", ")}`);
  if (!/^https?:\/\//.test(baseUrl)) throw new Error("base URL must start with http:// or https://");
  if (!apiKey) throw new Error("API key is required");
  for (const name of Object.keys(headers)) {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`invalid header name "${name}"`);
  }

  const [existing] = await db.select({ id: llmProviders.id }).from(llmProviders).where(eq(llmProviders.label, label)).limit(1);
  if (existing) throw new Error(`provider "${label}" already exists`);

  const [row] = await db
    .insert(llmProviders)
    .values({
      label,
      kind: input.kind,
      baseUrl,
      apiKeySealed: await seal({ apiKey }),
      extraHeaders: headers,
      enabled: input.enabled ?? true,
    })
    .returning();

  if (!row) throw new Error("provider insert returned no row");

  invalidateProviderCache();

  return toView(row, apiKey);
}

export async function removeProvider(id: string): Promise<void> {
  const result = await db.delete(llmProviders).where(eq(llmProviders.id, id)).returning({ id: llmProviders.id });
  if (result.length === 0) throw new Error("provider not found");
  invalidateProviderCache();
}

export async function findProvider(id: string): Promise<ResolvedProvider | null> {
  const cached = resolvedCache.get(id);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const [row] = await db.select().from(llmProviders).where(eq(llmProviders.id, id)).limit(1);
  if (!row || !row.enabled) return null;

  const value: ResolvedProvider = {
    id: row.id,
    label: row.label,
    kind: isKind(row.kind) ? row.kind : "openai-compatible",
    baseUrl: row.baseUrl,
    apiKey: await decryptKey(row.apiKeySealed),
    headers: row.extraHeaders ?? {},
  };

  resolvedCache.set(id, { value, expiresAt: Date.now() + CACHE_TTL_MS });

  return value;
}

export async function ensureDefaultProvider(): Promise<ResolvedProvider | null> {
  const [existing] = await db.select().from(llmProviders).orderBy(asc(llmProviders.createdAt)).limit(1);
  if (existing) {
    return findProvider(existing.id);
  }

  const baseUrl = process.env.NINE_ROUTER_URL;
  const apiKey = process.env.NINE_ROUTER_API_KEY;
  if (!baseUrl || !apiKey) return null;

  try {
    const view = await addProvider({
      label: "9router",
      kind: "9router",
      baseUrl,
      apiKey,
    });

    return findProvider(view.id);
  } catch (error) {
    const [row] = await db.select({ id: llmProviders.id }).from(llmProviders).where(eq(llmProviders.label, "9router")).limit(1);
    if (row) return findProvider(row.id);
    throw error;
  }
}

export async function defaultProvider(): Promise<ResolvedProvider | null> {
  const [row] = await db.select({ id: llmProviders.id }).from(llmProviders).where(eq(llmProviders.enabled, true)).orderBy(asc(llmProviders.createdAt)).limit(1);
  if (row) return findProvider(row.id);
  return ensureDefaultProvider();
}

export async function providerKey(providerId: string): Promise<string> {
  const provider = await findProvider(providerId);
  if (!provider) throw new Error("provider not found or disabled");
  return provider.apiKey;
}
