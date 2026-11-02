import { defineEventHandler, getQuery } from "h3";
import { requireProductResource } from "@server/utils/chatResource";
import { memory } from "@src/mastra";
import type { MastraDBMessage } from "@mastra/core/agent";

interface HistoryPart {
  type: "text" | "tool";
  role: string;
  text?: string;
  toolName?: string;
  state?: string;
}

interface HistoryMessage {
  id: string;
  role: string;
  createdAt: Date;
  parts: HistoryPart[];
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event);
  const resource = await requireProductResource(event, query.productId);

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const threadId = typeof query.threadId === "string" && UUID_RE.test(query.threadId) ? query.threadId : null;
  const page = Math.max(1, Number(query.page) || 1);
  const perPage = Math.min(50, Math.max(10, Number(query.perPage) || 30));

  const recalled = threadId
    ? ((await memory.recall({ threadId, resourceId: resource, perPage, page: page - 1 }).catch(() => null)) ??
      (await memory.listMessagesByResourceId({ resourceId: resource, perPage, page: page - 1 })))
    : await memory.listMessagesByResourceId({ resourceId: resource, perPage, page: page - 1 });

  const messages = (recalled.messages as MastraDBMessage[])
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m): HistoryMessage | null => {
      const parts: HistoryPart[] = [];
      for (const part of m.content.parts) {
        if (part.type === "text" && "text" in part && part.text) {
          parts.push({ type: "text", role: m.role, text: part.text });
        } else if (part.type === "tool-invocation" && "toolInvocation" in part && part.toolInvocation) {
          parts.push({
            type: "tool",
            role: m.role,
            toolName: part.toolInvocation.toolName ?? "tool",
            state: part.toolInvocation.state ?? "result",
          });
        }
      }
      if (parts.length === 0) return null;
      return { id: m.id, role: m.role, createdAt: m.createdAt, parts };
    })
    .filter((m): m is HistoryMessage => m !== null);

  return {
    messages,
    hasMore: recalled.hasMore,
    total: recalled.total,
  };
});
