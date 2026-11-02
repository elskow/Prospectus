import { defineEventHandler, getQuery, createError } from "h3";
import { requireUser } from "@server/utils/auth";
import { getCaptureStatus } from "@src/harness/cookie-capture";
import { seal } from "@src/lib/crypto";
import { db } from "@src/db";
import { credentials } from "@src/db/schema";
import { catalogEntry } from "@src/adapters/catalog";

export default defineEventHandler(async (event) => {
  await requireUser(event);
  const query = getQuery(event);
  const jobId = typeof query.jobId === "string" ? query.jobId : "";
  const job = getCaptureStatus(jobId);
  if (!job) {
    throw createError({ statusCode: 404, statusMessage: "capture job not found" });
  }

  if (job.status === "waiting") {
    return { status: "waiting" as const };
  }

  if (job.status === "failed") {
    return { status: "failed" as const, error: job.error };
  }

  const entry = catalogEntry(job.adapterType);
  if (!entry) {
    throw createError({ statusCode: 400, statusMessage: "unknown adapter type" });
  }

  const cookieNames = Object.keys(job.cookies ?? {});
  const unknown = cookieNames.filter((name) => !entry.credentialFields.some((field) => field.name === name));
  if (unknown.length > 0) {
    return { status: "failed" as const, error: `captured unexpected fields: ${unknown.join(", ")}` };
  }

  const payload = await seal(job.cookies);
  const [row] = await db
    .insert(credentials)
    .values({
      adapterType: job.adapterType,
      label: "browser-capture",
      payload,
      lastVerifiedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [credentials.adapterType, credentials.label],
      set: { payload, updatedAt: new Date(), lastVerifiedAt: new Date() },
    })
    .returning({
      id: credentials.id,
      adapterType: credentials.adapterType,
      label: credentials.label,
      lastVerifiedAt: credentials.lastVerifiedAt,
      createdAt: credentials.createdAt,
      updatedAt: credentials.updatedAt,
    });

  return {
    status: "captured" as const,
    credential: { ...row, fieldNames: cookieNames },
  };
});
