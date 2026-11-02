import type { SinkLead } from "@src/adapters/sink";
import { createTool } from "@mastra/core/tools";
import { db } from "@src/db";
import { campaigns, companies, contacts, leads } from "@src/db/schema";
import { resolveSinkForCampaign } from "@src/harness/sink-resolver";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

type ToolContextWithRequest = {
  requestContext?: { get?: (key: string) => unknown };
};

export const exportLeadsTool = createTool({
  id: "export-leads",
  description:
    "Export leads of one of the user's campaigns to the configured sink (Google Sheets or CSV). Returns the number of rows written and where they landed. Does not mark leads as run-synced — the next pipeline run still exports fresh leads itself.",
  inputSchema: z.object({
    campaignId: z.string().uuid().optional(),
    status: z.enum(["ready", "synced", "all"]).default("ready"),
    limit: z.number().int().min(1).max(500).default(100),
  }),

  execute: async (inputData, context) => {
    const userId = (context as ToolContextWithRequest | undefined)?.requestContext?.get?.("userId");
    if (typeof userId !== "string" || userId.length === 0) {
      return { ok: false as const, error: "no authenticated user on this conversation" };
    }

    let campaignId = inputData.campaignId;
    if (!campaignId) {
      const owned = await db
        .select({ id: campaigns.id })
        .from(campaigns)
        .where(eq(campaigns.userId, userId))
        .orderBy(sql`${campaigns.createdAt} desc`)
        .limit(2);
      if (owned.length === 0) return { ok: false as const, error: "the user has no campaigns yet" };
      if (owned.length > 1) {
        return {
          ok: false as const,
          needsChoice: true as const,
          error: "multiple campaigns exist; ask the user which one to export",
        };
      }
      campaignId = owned[0]?.id;
    }
    if (!campaignId) return { ok: false as const, error: "no campaign selected" };

    const [campaign] = await db
      .select({ id: campaigns.id, name: campaigns.name })
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.userId, userId)));
    if (!campaign) return { ok: false as const, error: `campaign ${campaignId} not found for this user` };

    const statusFilter = inputData.status === "all" ? inArray(leads.status, ["ready", "synced", "new"]) : eq(leads.status, inputData.status);

    const rows = await db
      .select({
        leadId: leads.id,
        companyId: leads.companyId,
        companyName: companies.name,
        city: companies.city,
        website: companies.website,
        discoveredAt: leads.createdAt,
        raw: companies.raw,
      })
      .from(leads)
      .innerJoin(companies, eq(companies.id, leads.companyId))
      .where(and(eq(leads.campaignId, campaignId), statusFilter))
      .orderBy(desc(leads.createdAt))
      .limit(inputData.limit);

    const contactRows =
      rows.length > 0
        ? await db
            .select({
              companyId: contacts.companyId,
              name: contacts.name,
              title: contacts.title,
              email: contacts.email,
              emailVerification: contacts.emailVerification,
              phone: contacts.phone,
              phoneNormalized: contacts.phoneNormalized,
              whatsapp: contacts.whatsapp,
              isDecisionMaker: contacts.isDecisionMaker,
            })
            .from(contacts)
            .where(
              inArray(
                contacts.companyId,
                rows.map((r) => r.companyId),
              ),
            )
        : [];

    const byCompany = new Map<string, typeof contactRows>();
    for (const c of contactRows) (byCompany.get(c.companyId) ?? byCompany.set(c.companyId, []).get(c.companyId))?.push(c);

    const sinkLeads: SinkLead[] = [];
    for (const row of rows) {
      const ranked = [...(byCompany.get(row.companyId) ?? [])].sort((a, b) => rankB(b) - rankB(a)).slice(0, 5);
      const entries = ranked.length > 0 ? ranked : [null];
      for (const c of entries) {
        sinkLeads.push({
          companyName: row.companyName,
          city: row.city,
          website: row.website,
          contactName: c?.name ?? null,
          contactTitle: c?.title ?? null,
          contactEmail: c?.email ?? null,
          emailVerification: c?.emailVerification ?? null,
          contactPhone: c?.phoneNormalized ?? c?.phone ?? null,
          contactWhatsapp: c?.whatsapp ?? null,
          isDecisionMaker: c?.isDecisionMaker ?? null,
          sourceUrl: (row.raw as { mapsPlaceUrl?: string } | null)?.mapsPlaceUrl ?? null,
          discoveredAt: row.discoveredAt ? row.discoveredAt.toISOString() : null,
        });
      }
    }

    if (sinkLeads.length === 0) {
      return { ok: true as const, written: 0, targetLocation: null, note: "no leads matched the filter" };
    }

    const resolved = await resolveSinkForCampaign(campaignId);
    const exportRunId = `export-${campaignId}`;
    const result = await resolved.adapter.write(sinkLeads, {
      userId,
      runId: exportRunId,
      credentials: resolved.credentials,
    });

    return {
      ok: true as const,
      campaign: campaign.name,
      filter: { status: inputData.status },
      matched: sinkLeads.length,
      written: result.written,
      targetLocation: result.targetLocation,
      warnings: result.warnings,
    };
  },
});

function rankB(c: {
  isDecisionMaker: boolean | null;
  name: string | null;
  email: string | null;
  whatsapp: string | null;
  phoneNormalized: string | null;
  phone: string | null;
}): number {
  let score = 0;
  if (c.isDecisionMaker) score += 10;
  if (c.name) score += 4;
  if (c.email) score += 2;
  if (c.whatsapp || (c.phoneNormalized && /^\+?62?08[1-9]/.test(c.phoneNormalized))) score += 3;
  if (c.phone) score += 1;
  return score;
}
