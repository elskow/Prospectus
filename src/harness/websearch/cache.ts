import { Effect } from "effect";
import { db } from "@src/db";
import { webSearchCache } from "@src/db/schema";
import { eq, lt } from "drizzle-orm";
import type { WebResult } from "@src/harness/websearch/types";

const CACHE_TTL_MS = 7 * 86_400_000;

const EMPTY_CACHE_TTL_MS = 24 * 3_600_000;

function normalizeQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, " ").trim();
}

export const hashQuery = (query: string): Effect.Effect<string> =>
  Effect.promise(() =>
    crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(normalizeQuery(query)))
      .then((digest) => Array.from(new Uint8Array(digest), (b: number) => b.toString(16).padStart(2, "0")).join("")),
  );

export const readCache = (hash: string): Effect.Effect<WebResult[] | null> =>
  Effect.promise(async () => {
    try {
      const [row] = await db.select().from(webSearchCache).where(eq(webSearchCache.queryHash, hash)).limit(1);
      if (!row) {
        return null;
      }
      const ttl = row.backend === "empty" ? EMPTY_CACHE_TTL_MS : CACHE_TTL_MS;
      if (Date.now() - row.createdAt.getTime() > ttl) {
        return null;
      }
      return row.results as WebResult[];
    } catch {
      return null;
    }
  });

export const writeCache = (hash: string, query: string, backend: string, results: WebResult[]): Effect.Effect<void> =>
  Effect.promise(async () => {
    try {
      await db
        .insert(webSearchCache)
        .values({ queryHash: hash, query, results, backend })
        .onConflictDoUpdate({
          target: webSearchCache.queryHash,
          set: { results, backend, createdAt: new Date() },
        });
    } catch {}
  });

export const pruneCache = (): Effect.Effect<void> =>
  Effect.promise(async () => {
    try {
      await db.delete(webSearchCache).where(lt(webSearchCache.createdAt, new Date(Date.now() - CACHE_TTL_MS)));
    } catch {}
  });
