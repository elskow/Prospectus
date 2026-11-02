import type { SourceAdapterDefinition } from "@src/adapters/types";
import { db } from "@src/db";
import { credentials } from "@src/db/schema";
import { open } from "@src/lib/crypto";
import { googleMapsPlugin } from "@src/plugins/builtin/google-maps";
import { instagramPlugin } from "@src/plugins/builtin/instagram";
import { linkedinPlugin } from "@src/plugins/builtin/linkedin";
import { threadsPlugin } from "@src/plugins/builtin/threads";
import { websearchPlugin } from "@src/plugins/builtin/websearch";
import { xPlugin } from "@src/plugins/builtin/x";
import { isNotNull } from "drizzle-orm";

export interface ResolvedSource {
  adapter: SourceAdapterDefinition;
  credentials: Record<string, string>;
}

export interface SourcePluginEntry {
  definition: SourceAdapterDefinition;
  credentialFields: { name: string; required: boolean }[];
}

export const SOURCE_PLUGIN_ENTRIES: SourcePluginEntry[] = [
  { definition: googleMapsPlugin.definition, credentialFields: googleMapsPlugin.catalog.credentialFields },
  { definition: instagramPlugin.definition, credentialFields: instagramPlugin.catalog.credentialFields },
  { definition: linkedinPlugin.definition, credentialFields: linkedinPlugin.catalog.credentialFields },
  { definition: xPlugin.definition, credentialFields: xPlugin.catalog.credentialFields },
  { definition: threadsPlugin.definition, credentialFields: threadsPlugin.catalog.credentialFields },
  { definition: websearchPlugin.definition, credentialFields: websearchPlugin.catalog.credentialFields },
];

export async function resolveSources(): Promise<ResolvedSource[]> {
  const rows = await db.select().from(credentials).where(isNotNull(credentials.lastVerifiedAt));

  const byAdapter: Record<string, Record<string, string>> = {};
  for (const row of rows) {
    if (row.lastVerifiedAt === null) continue;

    if (byAdapter[row.adapterType]) continue;

    byAdapter[row.adapterType] = await open<Record<string, string>>(row.payload);
  }

  const resolved: ResolvedSource[] = [];

  for (const entry of SOURCE_PLUGIN_ENTRIES) {
    const required = entry.credentialFields.filter((f) => f.required);
    const stored = byAdapter[entry.definition.type] ?? {};
    const missing = required.filter((f) => !stored[f.name]);

    if (missing.length > 0) continue;

    resolved.push({ adapter: entry.definition, credentials: stored });
  }

  return resolved;
}
