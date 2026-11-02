export interface PromptArgument {
  name: string;
  description: string;
  required?: boolean;
}

export interface PromptDefinition {
  name: string;
  description: string;
  arguments: PromptArgument[];
  render: (args: Record<string, string>) => string;
}

const campaignArgument: PromptArgument = {
  name: "campaignId",
  description: "Campaign UUID; omit to use the most recently created campaign.",
  required: false,
};

function campaignTarget(args: Record<string, string>): string {
  return args.campaignId ? `campaignId=${args.campaignId}` : "the most recent campaign (omit campaignId)";
}

export const PROMPTS: PromptDefinition[] = [
  {
    name: "campaign-setup",
    description: "Guided campaign intake: sector scope, area coverage, exclusions, and goal, with a draft before anything is created.",
    arguments: [],
    render: () =>
      [
        "Set up a Prospectus campaign through an intake conversation. Use the prospectus MCP tools only.",
        'Do not call create_campaign on the first message unless the user already supplied sector scope, area, exclusions, and goal. A one-line request like "cari industri manufaktur di Jakarta" is incomplete.',
        "",
        "Ask up to four things in one message, and offer concrete examples so the user can answer quickly:",
        "1. Sector scope: which manufacturing sub-sectors? Examples: makanan & minuman, tekstil & garmen, plastik & kemasan, logam & mesin, kimia, elektronik, kayu & furnitur, farmasi, otomotif, material bangunan. Suggest a starting set based on the user's language.",
        "2. Area coverage: city/metro plus sub-locations or industrial estates. Jakarta examples: Cakung, Pulogadung, Cilincing, Penjaringan, Kembangan, Cengkareng, Kalideres, Marunda, Tanjung Priok. Ask whether to cover the whole metro or specific areas.",
        "3. Exclusions: distributors, retailers, importers, competitors, warung/UMKM below a size threshold, or named companies. Propose sensible defaults.",
        "4. Daily goal: companies with an email on file. Default 500; ask only if the user seems to care about volume.",
        "",
        "Then present a compact draft and ask for confirmation:",
        "  Name: <derived name>",
        "  Niche: <sector list + business nouns, e.g. pabrik/manufaktur/produsen>",
        "  Area: <city + sub-locations>",
        "  Exclusions: <list>",
        "  Goal: <number>",
        'Ask: "Buat campaign ini? Balas ya, atau koreksi bagian mana."',
        "",
        "Only after explicit confirmation call create_campaign with those values. Then call campaign_health and report the campaignId, marketsSeeded, and suggestedAction. Never start a run in this flow.",
        "Reply in the user's language. Keep the intake to one short message, not an interrogation.",
      ].join("\n"),
  },
  {
    name: "daily-brief",
    description: "Compact campaign status and one next action, using agent_brief.",
    arguments: [campaignArgument],
    render: (args) =>
      [
        `Produce a short Prospectus brief for ${campaignTarget(args)}.`,
        '1. Call list_campaigns. If there are none, say "Prospectus: no campaigns yet" and stop.',
        "2. Call agent_brief with the chosen campaignId.",
        "3. Report at most 5 lines: name and niche; ready/goal with today's progress; markets active/pending/saturated; last run status and reason; the suggestedAction.",
        "4. If blockers is not empty, append one line naming them. Do not add commentary or repeat raw JSON.",
      ].join("\n"),
  },
  {
    name: "incident-triage",
    description: "Diagnose a failed or stalled Prospectus run and propose one corrective action without deleting data.",
    arguments: [campaignArgument],
    render: (args) =>
      [
        `Triage the current Prospectus problem for ${campaignTarget(args)}.`,
        "1. Call agent_brief. If the last run is queued or running, call run_status and wait_for_run with timeoutSeconds=60 once before concluding anything.",
        "2. If the last run failed, call list_runs with limit 3 and read the error; do not re-run blindly.",
        "3. Check ingest_status when the failure mentions zero companies or empty results.",
        "4. Call campaign_health for the market queue. Do not add markets or start a run in this workflow.",
        "5. Report: the failing stage or condition, the evidence (numbers or error code), and one next action. Never delete campaigns, suppressions, or leads.",
      ].join("\n"),
  },
];

export function findPrompt(name: string): PromptDefinition | undefined {
  return PROMPTS.find((prompt) => prompt.name === name);
}

export function promptList() {
  return PROMPTS.map((prompt) => ({
    name: prompt.name,
    description: prompt.description,
    arguments: prompt.arguments,
  }));
}

export function promptMessages(prompt: PromptDefinition, args: Record<string, string>) {
  return [
    {
      role: "user",
      content: { type: "text", text: prompt.render(args) },
    },
  ];
}
