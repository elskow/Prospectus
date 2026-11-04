import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { db } from "@src/db";
import { companies, contacts } from "@src/db/schema";
import { stampNotes, validateCandidate } from "@src/harness/validation";

export interface RevalidateResult {
  revalidated: number;
  promoted: number;
  demoted: number;
  kept: number;
}

const CHUNK_SIZE = 200;

function contactEmailRank(c: {
  isDecisionMaker: boolean | null;
  name: string | null;
  whatsapp: string | null;
  phone: string | null;
  phoneNormalized: string | null;
  emailType: "role" | "personal" | "verified-personal" | null;
}): number {
  let score = 0;
  if (c.isDecisionMaker) score += 10;
  if (c.name) score += 4;
  if (c.whatsapp) score += 3;
  if (c.phoneNormalized || c.phone) score += 1;
  if (c.emailType === "verified-personal") score += 8;
  else if (c.emailType === "personal") score += 4;
  else score += 2;
  return score;
}

export async function revalidateCompanies(input?: { country?: string; rule?: string; limit?: number }): Promise<RevalidateResult> {
  const result: RevalidateResult = { revalidated: 0, promoted: 0, demoted: 0, kept: 0 };

  const conditions = [eq(companies.status, "needs_review")];
  if (input?.country) conditions.push(eq(companies.country, input.country));
  if (input?.rule) {
    conditions.push(sql`exists (select 1 from jsonb_array_elements(${companies.validationNotes}) n where n->>'rule' = ${input.rule})`);
  }

  const processedIds = new Set<string>();
  for (;;) {
    const where = processedIds.size > 0 ? and(...conditions, notInArray(companies.id, [...processedIds])) : and(...conditions);

    const rows = await db
      .select({
        id: companies.id,
        name: companies.name,
        country: companies.country,
        phone: companies.phone,
        website: companies.website,
      })
      .from(companies)
      .where(where)
      .limit(CHUNK_SIZE);

    if (rows.length === 0) break;
    for (const r of rows) processedIds.add(r.id);

    const contactRows = await db
      .select({
        companyId: contacts.companyId,
        email: contacts.email,
        name: contacts.name,
        whatsapp: contacts.whatsapp,
        phone: contacts.phone,
        phoneNormalized: contacts.phoneNormalized,
        emailType: contacts.emailType,
        isDecisionMaker: contacts.isDecisionMaker,
      })
      .from(contacts)
      .where(
        and(
          inArray(
            contacts.companyId,
            rows.map((r) => r.id),
          ),
          sql`${contacts.email} is not null`,
        ),
      );

    const ranked = contactRows.map((c) => ({ c, score: contactEmailRank(c) })).sort((a, b) => b.score - a.score);
    const bestEmailByCompany = new Map<string, string>();
    for (const { c } of ranked) {
      if (c.email && !bestEmailByCompany.has(c.companyId)) bestEmailByCompany.set(c.companyId, c.email);
    }

    await db.transaction(async (tx) => {
      for (const row of rows) {
        const verdict = validateCandidate({
          name: row.name,
          email: bestEmailByCompany.get(row.id) ?? null,
          phone: row.phone,
          website: row.website,
          country: row.country,
        });
        if (verdict.level === "accept") {
          await tx.update(companies).set({ status: "valid", validationNotes: [], updatedAt: new Date() }).where(eq(companies.id, row.id));
          result.promoted += 1;
        } else if (verdict.level === "reject") {
          await tx
            .update(companies)
            .set({ status: "rejected", validationNotes: stampNotes(verdict.notes), updatedAt: new Date() })
            .where(eq(companies.id, row.id));
          result.demoted += 1;
        } else {
          await tx
            .update(companies)
            .set({ status: "needs_review", validationNotes: stampNotes(verdict.notes), updatedAt: new Date() })
            .where(eq(companies.id, row.id));
          result.kept += 1;
        }
        result.revalidated += 1;
      }
    });

    if (input?.limit !== undefined && input.limit > 0 && result.revalidated >= input.limit) break;
    if (rows.length < CHUNK_SIZE) break;
  }

  return result;
}
