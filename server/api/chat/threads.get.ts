import { defineEventHandler, getQuery } from "h3";
import { requireProductResource } from "@server/utils/chatResource";
import { memory } from "@src/mastra";
import type { MastraDBMessage } from "@mastra/core/agent";
import type { StorageThreadType } from "@mastra/core/memory";

const AUTO_TITLE_RE = /^New Thread /;

function truncate(text: string) {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed;
}

function firstUserText(messages: MastraDBMessage[]) {
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const part of m.content.parts) {
      if (part.type === "text" && "text" in part && part.text) return part.text;
    }
  }
  return null;
}

async function resolveTitle(thread: StorageThreadType) {
  if (thread.title && !AUTO_TITLE_RE.test(thread.title)) return truncate(thread.title);
  const recalled = await memory.recall({
    threadId: thread.id,
    page: 0,
    perPage: 1,
    orderBy: { field: "createdAt", direction: "ASC" },
  });
  const text = firstUserText(recalled.messages);
  return text ? truncate(text) : null;
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const resource = await requireProductResource(event, query.productId);

  const result = await memory.listThreads({
    filter: { resourceId: resource },
    page: 0,
    perPage: 100,
    orderBy: { field: "updatedAt", direction: "DESC" },
  });

  const threads = [];
  for (const thread of result.threads) {
    threads.push({
      id: thread.id,
      title: await resolveTitle(thread),
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    });
  }

  return { threads };
});
