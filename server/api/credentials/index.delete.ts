import { createError, defineEventHandler, getQuery } from "h3";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { requireUser } from "@server/utils/auth";
import { db } from "@src/db";
import { credentials } from "@src/db/schema";
import { invalidateSearchSettingsCache } from "@src/harness/websearch";

const deleteSchema = z.object({
  adapterType: z.string().min(3),
  label: z.string().min(1).max(100),
});

export default defineEventHandler(async (event) => {
  await requireUser(event);
  const query = deleteSchema.parse(getQuery(event));

  const deleted = await db
    .delete(credentials)
    .where(and(eq(credentials.adapterType, query.adapterType), eq(credentials.label, query.label)))
    .returning({ id: credentials.id });

  if (deleted.length === 0) {
    throw createError({ statusCode: 404, statusMessage: "credential not found" });
  }

  invalidateSearchSettingsCache();
  return { deleted: deleted.length };
});
