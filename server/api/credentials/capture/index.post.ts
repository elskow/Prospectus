import { defineEventHandler, readBody, createError } from "h3";
import { requireUser } from "@server/utils/auth";
import { CAPTURE_TARGETS, startCapture } from "@src/harness/cookie-capture";
import { prospectusConfig } from "../../../../prospectus.config";

export default defineEventHandler(async (event) => {
  await requireUser(event);

  const body = await readBody<{ adapterType?: string }>(event);
  const adapterType = body?.adapterType;
  if (!adapterType || !(adapterType in CAPTURE_TARGETS)) {
    throw createError({ statusCode: 400, statusMessage: "adapter does not support browser capture" });
  }
  if (!prospectusConfig.adapters.some((a) => a.type === adapterType && a.enabled)) {
    throw createError({ statusCode: 400, statusMessage: `adapter "${adapterType}" is not enabled` });
  }

  const job = startCapture(adapterType);
  const target = CAPTURE_TARGETS[adapterType];
  if (!job || !target) {
    throw createError({ statusCode: 500, statusMessage: "failed to start capture browser" });
  }
  return {
    jobId: job.id,
    status: job.status,
    label: target.label,
  };
});
