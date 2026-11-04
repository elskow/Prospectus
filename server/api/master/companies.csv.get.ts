import { createError, defineEventHandler, getQuery, setResponseHeader } from "h3";
import { and, desc, inArray, sql } from "drizzle-orm";
import { requireUser } from "@server/utils/auth";
import { db } from "@src/db";
import { companies, contacts } from "@src/db/schema";
import { bestContact, buildCompanyWhere, decodeCursor, type CompanyFilters } from "./companies.get";

interface CsvContactRow {
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

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

const CHUNK_SIZE = 500;
const HEADERS = [
  "company",
  "city",
  "website",
  "industry",
  "contact_name",
  "contact_title",
  "email",
  "email_type",
  "email_verification",
  "phone",
  "whatsapp",
  "status",
  "discovered_at",
];

export default defineEventHandler(async (event) => {
  await requireUser(event);
  const query = getQuery(event);
  const q = typeof query.q === "string" ? query.q.trim() : "";
  const city = typeof query.city === "string" ? query.city.trim() : "";
  const industry = typeof query.industry === "string" ? query.industry.trim() : "";
  const status = typeof query.status === "string" ? query.status : "all";
  const reachable = typeof query.reachable === "string" ? query.reachable : "";
  const cursorRaw = typeof query.cursor === "string" ? query.cursor : "";
  const startCursor = cursorRaw ? decodeCursor(cursorRaw) : null;
  if (cursorRaw && !startCursor) throw createError({ statusCode: 400, statusMessage: "invalid cursor" });

  const filters: CompanyFilters = { q, city, industry, status, reachable };
  const where = buildCompanyWhere(filters);
  const res = event.node.res;
  let clientGone = false;
  res.on("close", () => {
    clientGone = true;
  });
  res.on("error", () => {
    clientGone = true;
  });

  const date = new Date();
  const ymd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
  setResponseHeader(event, "content-type", "text/csv; charset=utf-8");
  setResponseHeader(event, "content-disposition", `attachment; filename="master-${ymd}.csv"`);
  res.write(`${HEADERS.join(",")}\n`);

  let cursor = startCursor;
  while (!clientGone && !res.writableEnded) {
    const rows = await db
      .select({
        id: companies.id,
        name: companies.name,
        phone: companies.phone,
        website: companies.website,
        city: companies.city,
        industry: companies.industryCategory,
        status: companies.status,
        createdAt: companies.createdAt,
      })
      .from(companies)
      .where(cursor ? and(where, sql`(${companies.createdAt}, ${companies.id}) < (${cursor.createdAt.toISOString()}::timestamptz, ${cursor.id}::uuid)`) : where)
      .orderBy(desc(companies.createdAt), desc(companies.id))
      .limit(CHUNK_SIZE + 1);
    let hasMore = false;
    if (rows.length > CHUNK_SIZE) {
      hasMore = true;
      rows.pop();
    }
    if (rows.length === 0) break;

    const ids = rows.map((r) => r.id);
    const contactRows: CsvContactRow[] =
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

    const byCompany = new Map<string, CsvContactRow[]>();
    for (const c of contactRows) {
      const list = byCompany.get(c.companyId) ?? [];
      list.push(c);
      byCompany.set(c.companyId, list);
    }

    for (const row of rows) {
      const best = bestContact(byCompany.get(row.id) ?? []);
      res.write(
        `${[
          row.name,
          row.city ?? "",
          row.website ?? "",
          row.industry ?? "",
          best?.name ?? "",
          best?.title ?? "",
          best?.email ?? "",
          best?.emailType ?? "",
          best?.emailVerification ?? "",
          best?.phone ?? row.phone ?? "",
          best?.whatsapp ?? "",
          row.status,
          row.createdAt.toISOString(),
        ]
          .map((v) => csvEscape(v))
          .join(",")}\n`,
      );
    }

    const last = rows[rows.length - 1];
    if (!last) break;
    cursor = { createdAt: last.createdAt, id: last.id };
    if (!hasMore) break;
  }
  res.end();
});
