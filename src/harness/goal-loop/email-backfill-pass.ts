import type { RunPorts } from "@src/harness/goal-loop/context";
import { backfillRoleInbox } from "@src/harness/email-backfill";
import { promoteReadyLeads } from "@src/harness/persistence";
import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "@src/db";
import { companies, leads } from "@src/db/schema";

const TARGETS_PER_PASS = 40;
const MAX_ATTEMPTS = 2;
const CONCURRENCY = 8;

interface BackfillTarget {
  companyId: string;
  name: string;
  website: string;
}

async function pickTargets(campaignId: string): Promise<BackfillTarget[]> {
  const rows = await db
    .select({ companyId: companies.id, name: companies.name, website: companies.website })
    .from(companies)
    .innerJoin(leads, eq(leads.companyId, companies.id))
    .where(
      and(
        eq(leads.campaignId, campaignId),
        lt(companies.emailHuntAttempts, MAX_ATTEMPTS),
        sql`${companies.website} is not null`,
        sql`not exists (select 1 from contacts k where k.company_id = ${companies.id} and k.email is not null)`,
      ),
    )
    .orderBy(sql`${companies.emailHuntAttempts} asc`, companies.createdAt)
    .limit(TARGETS_PER_PASS);
  return rows.flatMap((row) => (row.website ? [{ companyId: row.companyId, name: row.name, website: row.website }] : []));
}

async function markAttempted(companyId: string): Promise<void> {
  await db
    .update(companies)
    .set({ emailHuntAttempts: sql`${companies.emailHuntAttempts} + 1`, updatedAt: new Date() })
    .where(eq(companies.id, companyId));
}

export async function runEmailBackfillPass(ports: RunPorts): Promise<number> {
  const targets = await pickTargets(ports.options.campaignId);
  if (targets.length === 0) return 0;

  ports.emit({ stage: "persist", message: `email backfill: ${targets.length} companies with a site but no email` });

  const queue = [...targets];
  let filled = 0;

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length > 0) {
        const target = queue.shift();
        if (!target) return;
        const inserted = await backfillRoleInbox({ companyId: target.companyId, companyName: target.name, website: target.website }, (stage, message) =>
          ports.emit({ stage, message }),
        ).catch(() => 0);
        await markAttempted(target.companyId).catch(() => {});
        filled += inserted;
      }
    }),
  );

  if (filled > 0) ports.emit({ stage: "persist", message: `email backfill added ${filled} role inboxes from ${targets.length} companies` });
  const promoted = await promoteReadyLeads(ports.options.campaignId).catch(() => 0);
  if (promoted > 0) ports.emit({ stage: "persist", message: `+${promoted} prospect rows ready (email on file)` });
  return filled;
}
