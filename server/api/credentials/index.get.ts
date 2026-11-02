import { defineEventHandler } from "h3";
import { requireUser } from "@server/utils/auth";
import { open } from "@src/lib/crypto";
import { db } from "@src/db";
import { credentials } from "@src/db/schema";
import { prospectusConfig } from "../../../prospectus.config";

export default defineEventHandler(async (event) => {
  await requireUser(event);
  const rows = await db
    .select({
      id: credentials.id,
      adapterType: credentials.adapterType,
      label: credentials.label,
      payload: credentials.payload,
      lastVerifiedAt: credentials.lastVerifiedAt,
      createdAt: credentials.createdAt,
      updatedAt: credentials.updatedAt,
    })
    .from(credentials);

  const withFields = await Promise.all(
    rows.map(async ({ payload, ...row }) => ({
      ...row,
      fieldNames: await credentialFieldNames(payload),
    })),
  );

  return {
    credentials: withFields,
    adapters: prospectusConfig.adapters,
  };
});

async function credentialFieldNames(payload: string): Promise<string[]> {
  try {
    const values = await open<Record<string, unknown>>(payload);
    return Object.keys(values);
  } catch {
    return [];
  }
}
