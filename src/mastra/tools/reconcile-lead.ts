import { createTool } from "@mastra/core/tools";
import { db } from "@src/db";
import { campaigns, companies, leads } from "@src/db/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

type ToolContextWithRequest = {
  requestContext?: { get?: (key: string) => unknown };
};

export const reconcileLeadTool = createTool({
  id: "reconcile-lead",
  description:
    "Correct wrong data on a lead: fix the company website or industry category. Never sets verdicts directly — supply corrected facts and let the pipeline re-qualify. With requalify=true the lead is reset to new/pending so the next campaign run re-researches it; with false only the stored fact changes and enrichment is re-flagged for website fixes.",
  inputSchema: z.object({
    leadId: z.string().uuid(),
    field: z.enum(["website", "industryCategory"]),
    value: z.string().min(1),
    reason: z.string().min(20).describe("Why the stored value is wrong and where the correction came from"),
    requalify: z.boolean().default(true).describe("Reset the lead so the next campaign run re-researches and re-qualifies it against the corrected facts"),
  }),

  execute: async (inputData, context) => {
    const userId = (context as ToolContextWithRequest | undefined)?.requestContext?.get?.("userId");
    if (typeof userId !== "string" || userId.length === 0) {
      return { ok: false as const, error: "no authenticated user on this conversation" };
    }

    const [row] = await db
      .select({
        leadId: leads.id,
        campaignId: leads.campaignId,
        companyId: companies.id,
        companyName: companies.name,
        website: companies.website,
        industryCategory: companies.industryCategory,
      })
      .from(leads)
      .innerJoin(companies, eq(companies.id, leads.companyId))
      .innerJoin(campaigns, eq(campaigns.id, leads.campaignId))
      .where(and(eq(leads.id, inputData.leadId), eq(campaigns.userId, userId)));

    if (!row) {
      return { ok: false as const, error: `lead ${inputData.leadId} not found for this user` };
    }

    const before = inputData.field === "website" ? row.website : row.industryCategory;
    let normalizedValue = inputData.value.trim();
    if (inputData.field === "website") {
      if (!/^https?:\/\//i.test(normalizedValue)) normalizedValue = `https://${normalizedValue}`;
      try {
        const url = new URL(normalizedValue);
        normalizedValue = url.origin;
      } catch {
        return { ok: false as const, error: `value is not a usable URL: ${inputData.value}` };
      }
    }

    if (inputData.field === "website") {
      await db.update(companies).set({ website: normalizedValue, updatedAt: new Date() }).where(eq(companies.id, row.companyId));
    } else {
      await db.update(companies).set({ industryCategory: normalizedValue, updatedAt: new Date() }).where(eq(companies.id, row.companyId));
    }

    let requalification = null;
    if (inputData.requalify) {
      await db.update(leads).set({ status: "new", enrichmentStatus: "pending", updatedAt: new Date() }).where(eq(leads.id, row.leadId));
      requalification = "lead reset to new/pending; the next campaign run re-researches and re-qualifies it";
    } else if (inputData.field === "website") {
      await db.update(leads).set({ enrichmentStatus: "pending", updatedAt: new Date() }).where(eq(leads.id, row.leadId));
    }

    return {
      ok: true as const,
      leadId: row.leadId,
      company: row.companyName,
      field: inputData.field,
      before,
      after: normalizedValue,
      reason: inputData.reason,
      requalification,
    };
  },
});
