import { eq } from "drizzle-orm";
import { db } from "@src/db";
import { ingestJobs } from "@src/db/schema";
import { runDirectoryIngest } from "@src/harness/ingest/run";
import "@src/harness/ingest/kemenperin";
import "@src/harness/ingest/kemendagexim";
import "@src/harness/ingest/indotrading";
import "@src/harness/ingest/indonetwork";

const adapterId = process.argv[2] ?? process.env.INGEST_ADAPTER_ID ?? "";
const pages = Number(process.argv[3] ?? 3);
const jobId = process.argv[4] ?? process.env.INGEST_JOB_ID ?? "";
const campaignIdx = process.argv.indexOf("--campaign");
const campaignId = (campaignIdx >= 0 ? process.argv[campaignIdx + 1] : "") || process.env.INGEST_CAMPAIGN_ID || null;

if (!adapterId) {
  console.error("usage: bun scripts/ingest-directory.ts <adapterId> [pages] [jobId]");
  process.exit(2);
}

try {
  const result = await runDirectoryIngest({
    adapterId,
    pages,
    jobId: jobId || undefined,
    campaignId,
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
