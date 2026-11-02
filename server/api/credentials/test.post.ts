import { createError, defineEventHandler, readBody } from "h3";
import { and, eq } from "drizzle-orm";
import { requireUser } from "@server/utils/auth";
import { z } from "zod";
import { db } from "@src/db";
import { credentials } from "@src/db/schema";
import { open } from "@src/lib/crypto";
import { catalogEntry } from "@src/adapters/catalog";
import { prospectusConfig } from "../../../prospectus.config";

const testSchema = z.object({
  adapterType: z.string().min(3),
  label: z.string().min(1).max(100),
});

export default defineEventHandler(async (event) => {
  await requireUser(event);
  const body = testSchema.parse(await readBody(event));

  const [row] = await db
    .select()
    .from(credentials)
    .where(and(eq(credentials.adapterType, body.adapterType), eq(credentials.label, body.label)));

  if (!row) {
    throw createError({ statusCode: 404, statusMessage: "credential not found" });
  }

  let values: Record<string, string>;
  try {
    values = await open<Record<string, string>>(row.payload);
  } catch {
    throw createError({ statusCode: 500, statusMessage: "stored credential payload failed to decrypt" });
  }

  const entry = catalogEntry(body.adapterType);
  const missing = entry ? entry.credentialFields.filter((f) => f.required && !values[f.name]).map((f) => f.name) : [];

  const now = new Date();
  await db.update(credentials).set({ lastVerifiedAt: now, updatedAt: now }).where(eq(credentials.id, row.id));

  return {
    ok: missing.length === 0,
    missing,
    verifiedAt: now.toISOString(),
  };
});
