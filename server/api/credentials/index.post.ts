import { createError, defineEventHandler, readBody } from "h3";
import { requireUser } from "@server/utils/auth";
import { z } from "zod";
import { db } from "@src/db";
import { credentials } from "@src/db/schema";
import { seal } from "@src/lib/crypto";
import { invalidateSearchSettingsCache } from "@src/harness/websearch";
import { catalogEntry } from "@src/adapters/catalog";
import { prospectusConfig } from "../../../prospectus.config";

const createSchema = z.object({
  adapterType: z.string().min(3),
  label: z.string().min(1).max(100),
  values: z.record(z.string(), z.string()),
});

export default defineEventHandler(async (event) => {
  await requireUser(event);
  const body = createSchema.parse(await readBody(event));

  const entry = catalogEntry(body.adapterType);
  if (!entry) {
    throw createError({ statusCode: 400, statusMessage: `unknown adapter type "${body.adapterType}"` });
  }
  if (!prospectusConfig.adapters.some((a) => a.type === body.adapterType && a.enabled)) {
    throw createError({ statusCode: 400, statusMessage: `adapter "${body.adapterType}" is not enabled` });
  }

  const missing = entry.credentialFields.filter((f) => f.required && body.values[f.name] === undefined);
  if (missing.length > 0) {
    throw createError({
      statusCode: 400,
      statusMessage: `missing credential fields: ${missing.map((f) => f.name).join(", ")}`,
    });
  }
  const unknown = Object.keys(body.values).filter((k) => !entry.credentialFields.some((f) => f.name === k));
  if (unknown.length > 0) {
    throw createError({
      statusCode: 400,
      statusMessage: `unknown credential fields: ${unknown.join(", ")}`,
    });
  }

  const payload = await seal(body.values);
  const [row] = await db
    .insert(credentials)
    .values({
      adapterType: body.adapterType,
      label: body.label,
      payload,
      lastVerifiedAt: null,
    })
    .onConflictDoUpdate({
      target: [credentials.adapterType, credentials.label],
      set: { payload, updatedAt: new Date(), lastVerifiedAt: null },
    })
    .returning({
      id: credentials.id,
      adapterType: credentials.adapterType,
      label: credentials.label,
      lastVerifiedAt: credentials.lastVerifiedAt,
      createdAt: credentials.createdAt,
      updatedAt: credentials.updatedAt,
    });
  invalidateSearchSettingsCache();
  return { credential: row };
});
