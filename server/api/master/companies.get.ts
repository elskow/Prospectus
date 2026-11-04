import { createError, defineEventHandler, getQuery } from "h3";
import { and, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { requireUser } from "@server/utils/auth";
import { db } from "@src/db";
import { companies, contacts } from "@src/db/schema";

type CompanyStatus = "valid" | "needs_review" | "rejected";

interface ContactRow {
  companyId: string;
  name: string | null;
  title: string | null;
  email: string | null;
  emailType: "role" | "personal" | "verified-personal" | null;
  emailVerification: "unverified" | "mx-ok" | "smtp-ok" | "catch-all" | "undeliverable" | null;
  phone: string | null;
  phoneNormalized: string | null;
  whatsapp: string | null;
  isDecisionMaker: boolean | null;
}

function rank(c: ContactRow): number {
  let score = 0;
  if (c.isDecisionMaker) score += 10;
  if (c.name) score += 4;
  if (c.whatsapp) score += 3;
  if (c.phoneNormalized || c.phone) score += 1;
  if (c.email) {
    if (c.emailType === "verified-personal") score += 8;
    else if (c.emailType === "personal") score += 4;
    else score += 2;
  }
  return score;
}

export function bestContact(list: ContactRow[]) {
  const withEmail = list.filter((c) => c.email);
  if (withEmail.length === 0) return null;
  const best = [...withEmail].sort((a, b) => rank(b) - rank(a))[0];
  if (!best) return null;
  return {
    name: best.name,
    title: best.title,
    email: best.email,
    emailType: best.emailType,
    emailVerification: best.emailVerification,
    phone: best.phoneNormalized ?? best.phone,
    whatsapp: best.whatsapp,
  };
}

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, "utf8").toString("base64");
}

export function decodeCursor(raw: string): { createdAt: Date; id: string } | null {
  const decoded = Buffer.from(raw, "base64").toString("utf8");
  const sep = decoded.lastIndexOf("|");
  if (sep <= 0) return null;
  const createdAt = new Date(decoded.slice(0, sep));
  const id = decoded.slice(sep + 1);
  if (Number.isNaN(createdAt.getTime()) || !id) return null;
  return { createdAt, id };
}

export interface CompanyFilters {
  q?: string;
  city?: string;
  industry?: string;
  status?: string;
  reachable?: string;
}

export function buildCompanyWhere(f: CompanyFilters) {
  const clauses = [];
  if (f.q) clauses.push(ilike(companies.name, `%${f.q}%`));
  if (f.city) clauses.push(eq(companies.city, f.city));
  if (f.industry) clauses.push(eq(companies.industryCategory, f.industry));
  if (f.status === "valid" || f.status === "needs_review" || f.status === "rejected") clauses.push(eq(companies.status, f.status));
  if (f.reachable === "email") clauses.push(eq(companies.hasEmail, true));
  return clauses.length > 0 ? and(...clauses) : undefined;
}

export default defineEventHandler(async (event) => {
  await requireUser(event);
  const query = getQuery(event);
  const q = typeof query.q === "string" ? query.q.trim() : "";
  const city = typeof query.city === "string" ? query.city.trim() : "";
  const industry = typeof query.industry === "string" ? query.industry.trim() : "";
  const status = typeof query.status === "string" ? query.status : "all";
  const reachable = typeof query.reachable === "string" ? query.reachable : "";
  const rawLimit = typeof query.limit === "string" ? Number.parseInt(query.limit, 10) : Number.NaN;
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
  const cursorRaw = typeof query.cursor === "string" ? query.cursor : "";
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) throw createError({ statusCode: 400, statusMessage: "invalid cursor" });

  const where = buildCompanyWhere({ q, city, industry, status, reachable });
  const rows = await db
    .select({
      id: companies.id,
      name: companies.name,
      website: companies.website,
      phone: companies.phone,
      city: companies.city,
      industry: companies.industryCategory,
      status: companies.status,
      hasEmail: companies.hasEmail,
      validationNotes: companies.validationNotes,
      createdAt: companies.createdAt,
    })
    .from(companies)
    .where(cursor ? and(where, sql`(${companies.createdAt}, ${companies.id}) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`) : where)
    .orderBy(desc(companies.createdAt), desc(companies.id))
    .limit(limit + 1);

  let hasMore = false;
  if (rows.length > limit) {
    hasMore = true;
    rows.pop();
  }
  const last = rows[rows.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

  const ids = rows.map((r) => r.id);
  const contactRows: ContactRow[] =
    ids.length > 0
      ? await db
          .select({
            companyId: contacts.companyId,
            name: contacts.name,
            title: contacts.title,
            email: contacts.email,
            emailType: contacts.emailType,
            emailVerification: contacts.emailVerification,
            phone: contacts.phone,
            phoneNormalized: contacts.phoneNormalized,
            whatsapp: contacts.whatsapp,
            isDecisionMaker: contacts.isDecisionMaker,
          })
          .from(contacts)
          .where(inArray(contacts.companyId, ids))
      : [];

  const byCompany = new Map<string, ContactRow[]>();
  for (const c of contactRows) {
    const list = byCompany.get(c.companyId) ?? [];
    list.push(c);
    byCompany.set(c.companyId, list);
  }

  return {
    companies: rows.map((row) => ({
      id: row.id,
      name: row.name,
      website: row.website,
      phone: row.phone,
      city: row.city,
      industry: row.industry,
      status: row.status satisfies CompanyStatus,
      hasEmail: row.hasEmail,
      validationNotes: row.validationNotes,
      createdAt: row.createdAt.toISOString(),
      contactCount: (byCompany.get(row.id) ?? []).length,
      emailCount: (byCompany.get(row.id) ?? []).filter((c) => c.email).length,
      bestContact: bestContact(byCompany.get(row.id) ?? []),
    })),
    nextCursor,
  };
});
