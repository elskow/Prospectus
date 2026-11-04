import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@src/db";
import { campaigns, users } from "@src/db/schema";
import { spawnRunWorker } from "@server/utils/run-spawner";
import { campaignNotFound, noUser } from "../errors";

export interface ToolDefinition {
  name: string;
  description: string;
  schema: z.ZodType;
  handler: (input: unknown) => Promise<unknown>;
}

export function resolveUserId(): Promise<string> {
  const email = process.env.PROSPECTUS_MCP_USER_EMAIL;
  return (async () => {
    const [user] = email
      ? await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1)
      : await db.select({ id: users.id }).from(users).orderBy(users.createdAt).limit(1);

    if (!user) throw noUser();
    return user.id;
  })();
}

export async function campaignFor(userId: string, campaignId?: string) {
  const where = campaignId ? and(eq(campaigns.userId, userId), eq(campaigns.id, campaignId)) : eq(campaigns.userId, userId);
  const [row] = await db.select().from(campaigns).where(where).orderBy(desc(campaigns.createdAt)).limit(1);
  if (!row) throw campaignNotFound();
  return row;
}

export function encodeCursor(row: { id: string; name: string }): string {
  return Buffer.from(`${row.name}\u0000${row.id}`).toString("base64url");
}

export function decodeCursor(raw: string | undefined): { name: string; id: string } | null {
  if (!raw) return null;
  try {
    const [name, id] = Buffer.from(raw, "base64url").toString("utf8").split("\u0000");
    if (!name || !id) return null;
    return { name, id };
  } catch {
    return null;
  }
}

export function spawnWorker(queueId: string): void {
  spawnRunWorker(queueId);
}
