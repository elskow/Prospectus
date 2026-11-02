import { createError, defineEventHandler, readBody } from "h3";
import { handleChatStream } from "@mastra/ai-sdk";
import { createUIMessageStreamResponse } from "ai";
import { RequestContext } from "@mastra/core/request-context";
import { requireUser } from "@server/utils/auth";
import { requireProductResource } from "@server/utils/chatResource";
import { mastra } from "@src/mastra";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default defineEventHandler(async (event) => {
  const user = await requireUser(event);
  const params = await readBody(event);

  const threadId = typeof params?.threadId === "string" && UUID_RE.test(params.threadId) ? params.threadId : crypto.randomUUID();
  const resource = await requireProductResource(event, params?.productId);

  const requestContext = new RequestContext();
  requestContext.set("userId", user.id);
  requestContext.set("userId", resource);

  const stream = await handleChatStream({
    mastra,
    agentId: "chat-agent",
    version: "v7",
    defaultOptions: {
      maxSteps: 12,
    },
    sendReasoning: true,
    params: {
      ...params,
      untilIdle: { maxIdleMs: 120_000 },
      requestContext,
      memory: {
        thread: threadId,
        resource,
      },
    },
  });

  return createUIMessageStreamResponse({ stream });
});
