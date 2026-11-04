import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "@src/db";
import { companies, type HuntTargetOutcome } from "@src/db/schema";
import { backfillNamedContactEmails, websiteDomainOf } from "@src/harness/email-backfill";
import { websiteMatchesCompany } from "@src/harness/contact-discovery";
import type { HarnessTracer } from "@src/harness/tracer";
import { refreshCompanyEmailFlag } from "@src/harness/persistence";
import { domainHasMailInfrastructure } from "@src/harness/osint-contacts";

export interface HuntFilter {
  q?: string;
  city?: string;
  industry?: string;
  onlyNoEmail?: boolean;
  limit?: number;
  companyIds?: string[];
}

const noopTracer: HarnessTracer = {
  traceId: null,
  async span<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  },
  async flush(): Promise<void> {},
};

function buildWhere(filter: HuntFilter): SQL {
  const conditions: SQL[] = [sql`${companies.website} is not null`, sql`${companies.emailHuntAttempts} < 2`];

  if (filter.companyIds && filter.companyIds.length > 0) {
    conditions.push(inArray(companies.id, filter.companyIds));
  } else {
    if (filter.q && filter.q.trim().length > 0) {
      conditions.push(sql`${companies.name} ilike ${`%${filter.q.trim()}%`}`);
    }
    if (filter.city && filter.city.trim().length > 0) {
      conditions.push(eq(companies.city, filter.city.trim()));
    }
    if (filter.industry && filter.industry.trim().length > 0) {
      conditions.push(eq(companies.industryCategory, filter.industry.trim()));
    }
  }

  if (filter.onlyNoEmail !== false) {
    conditions.push(sql`not exists (select 1 from contacts k where k.company_id = ${companies.id} and k.email is not null)`);
  }

  return sql.join(conditions, sql` and `);
}

export async function pickHuntTargets(filter: HuntFilter): Promise<{ id: string; name: string; website: string }[]> {
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
  const rows = await db
    .select({ id: companies.id, name: companies.name, website: companies.website })
    .from(companies)
    .where(buildWhere(filter))
    .orderBy(asc(companies.emailHuntAttempts), asc(companies.createdAt))
    .limit(limit);
  return rows.flatMap((row) => (row.website ? [{ id: row.id, name: row.name, website: row.website }] : []));
}

async function markAttempted(companyId: string): Promise<void> {
  await db
    .update(companies)
    .set({ emailHuntAttempts: sql`${companies.emailHuntAttempts} + 1`, updatedAt: new Date() })
    .where(eq(companies.id, companyId));
}

export async function huntCompany(target: {
  id: string;
  name: string;
  website: string;
}): Promise<{ emailsFound: number; outcome: HuntTargetOutcome["outcome"] }> {
  const domain = websiteDomainOf(target.website);
  if (!domain) return { emailsFound: 0, outcome: "no_website" };

  let siteReachable = false;
  try {
    const res = await fetch(target.website, { redirect: "follow", signal: AbortSignal.timeout(8_000), headers: { "user-agent": HUNT_UA } });
    siteReachable = res.status < 500;
  } catch {
    siteReachable = false;
  }
  if (!siteReachable) return { emailsFound: 0, outcome: "site_unreachable" };

  if (!(await domainHasMailInfrastructure(domain).catch(() => false))) return { emailsFound: 0, outcome: "no_mx" };
  if (!websiteMatchesCompany(`https://${domain}`, target.name)) return { emailsFound: 0, outcome: "domain_mismatch" };

  let emailsFound = 0;
  let outcome: HuntTargetOutcome["outcome"] = "site_unreachable";
  try {
    const result = await backfillNamedContactEmails({ companyId: target.id, companyName: target.name, website: target.website }, noopTracer, () => {});
    emailsFound = result.emailsFound;
    outcome = result.outcome;
  } finally {
    if (outcome !== "site_unreachable" && outcome !== "no_mx") {
      await markAttempted(target.id).catch(() => {});
    }
    await refreshCompanyEmailFlag(target.id).catch(() => {});
  }
  return { emailsFound, outcome };
}

const HUNT_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";
