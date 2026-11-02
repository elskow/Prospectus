import { defineEventHandler, getRouterParam, getQuery, readBody, createError } from "h3";
import { requireProductResource } from "@server/utils/chatResource";
import { memory } from "@src/mastra";

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const resource = await requireProductResource(event, query.productId);
  const threadId = getRouterParam(event, "id");
  if (!threadId) {
    throw createError({ statusCode: 400, statusMessage: "threadId required" });
  }

  const thread = await memory.getThreadById({ threadId });
  if (!thread || thread.resourceId !== resource) {
    throw createError({ statusCode: 404, statusMessage: "not found" });
  }

  const body = await readBody<{ title?: string }>(event);
  const title = body?.title?.trim();
  if (!title || title.length > 200) {
    throw createError({ statusCode: 400, statusMessage: "valid title required" });
  }

  await memory.saveThread({ thread: { ...thread, title } });
  return { ok: true };
});
