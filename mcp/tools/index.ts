import { runCampaignTools } from "./campaign-tools";
import { runDirectoryTools } from "./directory-tools";
import { runMarketTools } from "./market-tools";
import { runProspectTools } from "./prospect-tools";
import { runRunTools } from "./run-tools";
import type { ToolDefinition } from "./shared";

export type { ToolDefinition } from "./shared";

export async function runTools(): Promise<ToolDefinition[]> {
  const [campaign, directory, market, prospect, run] = await Promise.all([
    runCampaignTools(),
    runDirectoryTools(),
    runMarketTools(),
    runProspectTools(),
    runRunTools(),
  ]);
  return [...campaign, ...market, ...run, ...prospect, ...directory];
}
