import { createError, defineEventHandler, getRouterParam } from "h3";
import { and, eq } from "drizzle-orm";
import { requireUser } from "@server/utils/auth";
import { db } from "@src/db";
import { campaigns } from "@src/db/schema";

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, "id");
  if (!id) throw createError({ statusCode: 400, statusMessage: "missing campaign id" });

  const [row] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  if (!row) throw createError({ statusCode: 404, statusMessage: "campaign not found" });

  return { campaign: row };
});
