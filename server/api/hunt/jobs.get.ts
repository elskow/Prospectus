import { defineEventHandler } from "h3";
import { requireUser } from "@server/utils/auth";
import { listHuntJobs } from "@src/harness/hunt-queue";

export default defineEventHandler(async (event) => {
  await requireUser(event);
  return { jobs: await listHuntJobs(20) };
});
