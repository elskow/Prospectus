import type { H3Event } from "h3";
import { requireUser } from "@server/utils/auth";

export async function requireChatResource(event: H3Event, productId: unknown): Promise<string> {
  const user = await requireUser(event);
  void productId;
  return user.id;
}

export const requireProductResource = requireChatResource;
