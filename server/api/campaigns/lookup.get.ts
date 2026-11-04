import { createError, defineEventHandler, getQuery } from "h3";
import { asc, ilike } from "drizzle-orm";
import { requireUser } from "@server/utils/auth";
import { db } from "@src/db";
import { companies } from "@src/db/schema";

export default defineEventHandler(async (event) => {
  await requireUser(event);
  const query = getQuery(event);
  const q = typeof query.q === "string" ? query.q.trim() : "";
  if (q.length < 2) throw createError({ statusCode: 400, statusMessage: "query must be at least 2 characters" });

  const rows = await db
    .select({ id: companies.id, name: companies.name, city: companies.city })
    .from(companies)
    .where(ilike(companies.name, `%${q}%`))
    .orderBy(asc(companies.name))
    .limit(10);
  return { companies: rows };
});
