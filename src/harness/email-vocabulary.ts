import { sql } from "drizzle-orm";
import { db } from "@src/db";

const CACHE_TTL_MS = 10 * 60_000;

const SEED_PREFIXES = ["info", "sales", "marketing", "hrd", "admin", "contact", "cs", "office"];

let cache: { at: number; prefixes: string[] } | null = null;

function usable(localPart: string): boolean {
  if (localPart.length < 3 || localPart.length > 24) return false;
  if (!/^[a-z][a-z0-9._-]*$/.test(localPart)) return false;
  if (/\d{4,}/.test(localPart)) return false;
  return true;
}

export async function learnRolePrefixes(limit = 12): Promise<string[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.prefixes;

  const rows = (await db.execute<{ local: string; domains: number }>(sql`
    select split_part(lower(email), '@', 1) as local, count(distinct split_part(lower(email), '@', 2))::int as domains
    from contacts
    where email is not null and position('@' in email) > 1
    group by 1
    having count(distinct split_part(lower(email), '@', 2)) >= 2
    order by domains desc, local
    limit ${limit * 3}
  `)) as unknown as { local: string; domains: number }[];

  const learned = rows
    .map((row) => row.local.trim())
    .filter(usable)
    .slice(0, limit);

  cache = { at: Date.now(), prefixes: learned.length >= 3 ? learned : SEED_PREFIXES };
  return cache.prefixes;
}

export function invalidateRolePrefixes(): void {
  cache = null;
}
