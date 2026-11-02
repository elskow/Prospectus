import { eq } from "drizzle-orm";
import { db } from "@src/db";
import { ingestJobs } from "@src/db/schema";
import { ingestKemenperin } from "@src/harness/ingest/kemenperin";

const campaignId = process.argv[2] ?? process.env.INGEST_CAMPAIGN_ID ?? "";
const pages = Number(process.argv[3] ?? 3);
const jobId = process.argv[4] ?? process.env.INGEST_JOB_ID ?? "";

if (!campaignId) {
  console.error("usage: bun scripts/ingest-kemenperin.ts <campaignId> [pages] [jobId]");
  process.exit(2);
}

try {
  const result = await ingestKemenperin({
    campaignId,
    pages,
    jobId: jobId || undefined,
    onProgress: (message) => console.log(message),
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (jobId) {
    await db
      .update(ingestJobs)
      .set({ status: "failed", error: message, finishedAt: new Date(), updatedAt: new Date() })
      .where(eq(ingestJobs.id, jobId))
      .catch(() => {});
  }
  console.error(`ingest failed: ${message}`);
  process.exit(1);
}
