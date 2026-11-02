import type { SinkAdapterDefinition } from "@src/adapters/types";
import { db } from "@src/db";
import { campaigns, credentials } from "@src/db/schema";
import { open } from "@src/lib/crypto";
import { csvPlugin } from "@src/plugins/builtin/csv";
import { googleSheetsPlugin } from "@src/plugins/builtin/google-sheets";
import { eq } from "drizzle-orm";

export interface ResolvedSink {
  adapter: SinkAdapterDefinition;
  credentials: Record<string, string>;
}

async function sheetsCredentials(): Promise<Record<string, string> | null> {
  const rows = await db.select().from(credentials).where(eq(credentials.adapterType, "sink:google-sheets"));

  for (const row of rows) {
    const payload = await open<Record<string, string>>(row.payload);
    if (payload.refreshToken && payload.clientId && payload.clientSecret) return payload;
  }

  return null;
}

export async function resolveSinkForPlatform(): Promise<ResolvedSink> {
  const credentialsPayload = await sheetsCredentials();
  if (credentialsPayload) return { adapter: googleSheetsPlugin.definition, credentials: credentialsPayload };
  return { adapter: csvPlugin.definition, credentials: {} };
}

export async function resolveSinkForCampaign(campaignId: string): Promise<ResolvedSink> {
  const [campaign] = await db.select({ sinkConfig: campaigns.sinkConfig }).from(campaigns).where(eq(campaigns.id, campaignId));
  const target = campaign?.sinkConfig?.googleSheets;
  if (!target?.spreadsheetId && !target?.sheetName) return await resolveSinkForPlatform();

  const base = await sheetsCredentials();
  if (!base) return { adapter: csvPlugin.definition, credentials: {} };

  return {
    adapter: googleSheetsPlugin.definition,
    credentials: {
      ...base,
      ...(target.spreadsheetId ? { spreadsheetId: target.spreadsheetId } : {}),
      ...(target.sheetName ? { sheetName: target.sheetName } : {}),
    },
  };
}
