import { createTool } from "@mastra/core/tools";
import { db } from "@src/db";
import { campaigns, companies, contacts, leads } from "@src/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

export const leadLookupTool = createTool({
  id: "lead-lookup",
  description:
    "Look up prospect rows for one of the user's campaigns: company and contacts (decision makers first). Call this when the user wants to see or review found prospects. If campaignId is omitted, the user's most recent campaign is used automatically.",
  inputSchema: z.object({
    campaignId: z.string().uuid().optional(),
    status: z.enum(["new", "ready", "synced"]).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),

  execute: async (inputData, context) => {
    interface ToolContextWithRequest {
      requestContext?: { get?: (key: string) => unknown };
    }
    const userId = (context as ToolContextWithRequest | undefined)?.requestContext?.get?.("userId");
    if (typeof userId !== "string" || userId.length === 0) {
      throw new Error("no authenticated user");
    }

    let campaignId = inputData.campaignId;
    if (!campaignId) {
      const rows = await db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns).orderBy(desc(campaigns.createdAt));

      if (rows.length === 0) {
        return {
          ok: false as const,
          error: "the user has no campaigns yet; ask them to create one on the Campaigns page",
        };
      }

      if (rows.length > 1) {
        return {
          ok: true as const,
          needsChoice: true as const,
          campaigns: rows.map((r) => ({ id: r.id, name: r.name })),
          error: "multiple campaigns exist; ask the user which one to look up",
        };
      }

      campaignId = rows[0]?.id;
    }

    if (!campaignId) {
      return { ok: false as const, error: "no campaign selected" };
    }

    const [campaign] = await db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns).where(eq(campaigns.id, campaignId));

    if (!campaign) {
      return { ok: false as const, error: `campaign ${campaignId} not found for this user` };
    }

    const rows = await db
      .select({
        companyName: companies.name,
        website: companies.website,
        city: companies.city,
        status: leads.status,
        contactCount: sql<number>`(select count(*)::int from ${contacts} c where c.company_id = ${companies.id})`,
        topContact: sql<string | null>`(select c.name from ${contacts} c where c.company_id = ${companies.id} and c.is_decision_maker = true limit 1)`,
        topEmail: sql<
          string | null
        >`(select c.email from ${contacts} c where c.company_id = ${companies.id} and c.is_decision_maker = true and c.email is not null limit 1)`,
      })
      .from(leads)
      .innerJoin(companies, eq(companies.id, leads.companyId))
      .innerJoin(campaigns, eq(campaigns.id, leads.campaignId))
      .where(and(eq(leads.campaignId, campaignId), ...(inputData.status ? [eq(leads.status, inputData.status)] : [])))
      .orderBy(desc(leads.createdAt))
      .limit(inputData.limit ?? 10);

    return {
      ok: true as const,
      campaign: { id: campaign.id, name: campaign.name },
      leads: rows,
    };
  },
});
