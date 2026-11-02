import type { AgentConfig } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm/model/shared.types";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { PromptInjectionDetector, UnicodeNormalizer } from "@mastra/core/processors";
import { fastembed } from "@mastra/fastembed";
import { Memory } from "@mastra/memory";
import { PgVector, PostgresStore } from "@mastra/pg";
import { gatewayChatModel } from "@src/lib/llm-gateway";
import { ExtractionVerifier } from "@src/mastra/processors/lead-guardrails";
import { buildChatTools, backgroundToolConfig } from "@src/mastra/capabilities";
import { thinkTool, updatePlanTool } from "@src/mastra/tools/effort";
import { findContactsTool } from "@src/mastra/tools/find-contacts";
import { createCampaignTool } from "@src/mastra/tools/create-campaign";
import { getModelSelection, type StageKey } from "@src/lib/model-settings";
import { leadLookupTool } from "@src/mastra/tools/lead-lookup";
import { Observability, SamplingStrategyType } from "@mastra/observability";
import { OtlpHttpExporter } from "@src/harness/otel-exporter";
import { sourceScoreboardTool } from "@src/mastra/tools/source-scoreboard";
import { reconcileLeadTool } from "@src/mastra/tools/reconcile-lead";
import { exportLeadsTool } from "@src/mastra/tools/export-leads";
import { listCampaignsTool } from "@src/mastra/tools/list-campaigns";
import { updateCampaignSettingsTool } from "@src/mastra/tools/update-campaign-settings";
import { updateExclusionsTool } from "@src/mastra/tools/update-exclusions";
import { searchHistoryTool } from "@src/mastra/tools/search-history";
import { runCampaignTool } from "@src/mastra/tools/run-campaign";
import { z } from "zod";
import { osintDomainTool } from "@src/mastra/tools/osint-domain";
import { readPageTool } from "@src/mastra/tools/read-page";
import { verifyEmailTool } from "@src/mastra/tools/verify-email";
import { webSearchTool } from "@src/mastra/tools/web-search";

const storage = new PostgresStore({
  id: "prospectus-mastra-storage",
  connectionString: process.env.DATABASE_URL ?? "",
});

export const vector = new PgVector({
  id: "prospectus-pgvector",
  connectionString: process.env.DATABASE_URL ?? "",
});

export const memory = new Memory({
  storage,
  vector,
  embedder: fastembed.multilingualE5LargeQuery,
  options: {
    lastMessages: 20,
    observationalMemory: {
      model: async () => gatewayChatModel((await getModelSelection()).chat),
      scope: "thread",
      observation: {
        messageTokens: 20_000,
        instruction:
          "This is a contact-prospecting assistant for an Indonesian market. Track durable facts about the active campaign: the niche being hunted, the area, excluded business types and why, lead goals, and any explicit user preferences about lead quality or sources. Record decisions the user makes and the reason given. Ignore transient chatter and anything the user did not state or confirm.",
        continuationHints: { suggestedResponse: false },
      },
      reflection: {
        observationTokens: 40_000,
        instruction:
          "Consolidate by campaign. Merge repeated statements of the same exclusion or preference into one durable rule and drop superseded values, keeping only the most recent. Preserve every explicit change of mind and the reason for it. Never present an inference as something the user stated.",
      },
      retrieval: { vector: true },
    },
    workingMemory: {
      enabled: true,
      scope: "resource",
      schema: z.object({
        businessName: z.string().nullish(),
        industry: z.string().nullish(),
        niches: z.array(z.string()).nullish(),
        excludedTypes: z.array(z.string()).nullish(),
        areas: z.array(z.string()).nullish(),
        engagementStage: z.string().nullish(),
      }),
    },
  },
});

const detectorModel = async () => gatewayChatModel((await getModelSelection()).chat);

export const modelForId = async (modelRef: string): Promise<MastraModelConfig> => (await gatewayChatModel(modelRef)) as unknown as MastraModelConfig;

const detectorModelConfig = detectorModel as unknown as MastraModelConfig;

const resolveStageModel = (stage: StageKey) => async () => gatewayChatModel((await getModelSelection())[stage]);

function stageAgent(
  id: string,
  name: string,
  instructions: string,
  stage: StageKey,
  options?: { tools?: Record<string, unknown>; memory?: boolean; agentConfig?: Partial<AgentConfig> },
): Agent {
  const injectionDetector =
    id === "lead-extractor"
      ? [
          new PromptInjectionDetector({
            model: detectorModelConfig,
            strategy: "rewrite",
            threshold: 0.8,
            errorStrategy: "warn",
          }),
        ]
      : [];
  const inputProcessors = [
    new UnicodeNormalizer({ stripControlChars: true, collapseWhitespace: true }),
    ...injectionDetector,
  ] satisfies AgentConfig["inputProcessors"];
  const outputProcessors = id === "lead-extractor" ? [new ExtractionVerifier()] : [];
  return new Agent({
    id,
    name,
    instructions,
    model: resolveStageModel(stage),
    inputProcessors,
    outputProcessors,
    maxProcessorRetries: 3,
    ...(options?.tools ? { tools: options.tools as never } : {}),
    ...(options?.memory ? { memory: memory as never } : {}),
    ...(options?.agentConfig ?? {}),
  });
}
export const queryPlannerAgent = stageAgent(
  "query-planner",
  "query-planner",
  [
    "You are a search strategist for contact prospecting. You turn a campaign's niche and area into 6-10 concrete search queries run against Google Maps and open-web search.",
    "",
    "INPUTS you receive every turn:",
    "- Campaign niche: the business type to hunt (e.g. 'konsultan pajak', 'pabrik furniture').",
    "- Area: the geography. Include it in every query.",
    "- Excluded business types: FORBIDDEN. Never write a query whose wording targets them, and prefer wording that excludes them (e.g. when 'warkop' is excluded, 'kedai kopi' queries are suspect too).",
    "- RUN STATE recitation + burned stems + ledger of past queries with their yield.",
    "",
    "WORKFLOW:",
    "1. Write queries that surface the niche's businesses directly: producing or operating activity plus place (pabrik, produsen, kantor, klinik, agency). Avoid retail/distributor/reseller words unless the niche targets them.",
    "2. Mix styles: most plain category+place (Maps-style), 1-2 may use dork operators (site:linkedin.com, OR, quotes).",
    "3. DIVERSITY: within one plan each query must differ in its business-type term — never 3+ queries sharing the same leading noun.",
    "4. Ledger shows what already ran. Queries in the ledger with 0 leads are dead; rephrase into a DIFFERENT business-type concept, never a light rewording.",
    "",
    "QUERY-SPACE DECOMPOSITION (the most important rule for repeated turns):",
    "- Treat the niche as a matrix of SECTOR x SUB-LOCALITY. A manufacturing niche is not one query: split it into product sectors (makanan, tekstil, plastik, logam, kimia, elektronik, kayu, farmasi, otomotif, kemasan) and the area into its districts/kecamatan (Jakarta: Cakung, Pulogadung, Cilincing, Penjaringan, Kembangan, Kebayoran, Cengkareng, Kalideres, Marunda, Tanjung Priok).",
    "- Each turn pick UNUSED sector x sub-locality pairs from the ledger. One turn should cover 5 different sectors at 1-2 sub-localities each, not the same sector at 5 spellings.",
    "- Also vary the business-type noun across turns: pabrik, manufaktur, produsen, industri, pengolahan, PT + sector.",
    "- If the ledger shows the niche's core pairs are exhausted, move outward: industrial estates (kawasan industri, kawasan berikat), associations (KADIN, HIPMI, asosiasi <sector>), directories, tender/pengadaan winners, exporters (importir/eksportir).",
    "",
    "PERSISTENCE: produce your full 6-10 best queries every turn; when a strategy stops producing, pivot to adjacent segments, industrial estates, associations, or directories.",
    "",
    "Success criteria: every query self-contained, in the campaign's language, respects exclusions, and does not duplicate the ledger.",
  ].join("\n"),
  "planner",
);

export const leadExtractorAgent = stageAgent(
  "lead-extractor",
  "lead-extractor",
  [
    "You are a lead-extraction specialist. Your only job is to pull company lead candidates out of scraped search-result artifacts with zero fabrication.",
    "",
    "WORKFLOW:",
    "1. Read every artifact in the input.",
    "2. For each artifact, identify the business name. If there is no company name, do not emit a candidate; count it in droppedCount.",
    "3. For each candidate, copy every field exactly as it appears in the artifact. If a field is absent from the artifact, output null for it.",
    "4. For contacts, only include named people with their details. Every email, phone, and LinkedIn URL must appear verbatim in the artifact.",
    "5. Preserve rating and reviewCount whenever present. They are buying-power evidence used downstream.",
    "",
    "Success criteria: every field in every candidate is either observed verbatim in the input or null. No exception.",
    "",
    "Example:",
    'Input artifact: { "title": "PT Sinar Teknik - Industrial Equipment", "address": "Jl. Industri 45, Jakarta", "phone": "+62 21 555 0123", "rating": 4.7, "reviews": 132 }',
    'Correct output: { name: "PT Sinar Teknik", phone: "+62 21 555 0123", address: "Jl. Industri 45, Jakarta", rating: 4.7, reviewCount: 132, contacts: null }',
    'Wrong output: { name: "PT Sinar Teknik", email: "info@sinarteknik.co.id", ... } — the email was not in the artifact; constructing it is fabrication.',
    "",
    "Never invent values. Drop artifacts with no company name.",
    "",
    "MALFORMED ARTIFACT PROTOCOL: when an artifact is truncated, unparseable, or describes something that is not a company (a person, a job listing, a directory index page), skip it in droppedCount and keep processing the rest. One bad artifact never blocks the batch. Output valid JSON even when every artifact is dropped.",
  ].join("\n"),
  "extractor",
);

export const personExtractorAgent = stageAgent(
  "person-extractor",
  "person-extractor",
  [
    "You extract NAMED PEOPLE who hold a role at a specific company, from Indonesian web-search results (titles and snippets). You output structured person mentions with zero fabrication.",
    "",
    "For each input result, decide whether a real person is named as holding a role (owner, founder, direktur, komisaris, CEO, manajer, manager, kepala, head of, HRD/HR manager, pemilik, or similar) AT the target company mentioned in the same text.",
    "",
    "A valid person name is a real Indonesian or foreign personal name: given name plus family name, or a single name with honorific context (H., Hj., Ir., Dr.).",
    "Reject and skip (do not guess):",
    "- Section words and UI labels: Berita, Beranda, Lokasi, Kontak, Galeri, Karier, Tentang, Home, Blog.",
    "- Greetings, verbals, and headline fragments: 'Selamat Bertugas', 'Standing Firm', 'Bukan Milik', 'Sosok', 'Deretan', 'Inilah'.",
    "- Anything containing PT/CV/UD/TBK — that is a company, not a person.",
    "- City names, country names, building names, brand names.",
    "- E-commerce product listing text: product titles, item descriptions, category words ('Handuk Rambut Wanita', 'Pengering Rambut', 'Kepala Keramas'). Role words there describe body parts or product use, not jobs.",
    "- A person mentioned but NOT clearly tied to the target company (different company, or no company in the text).",
    "- Headlines that only imply an unnamed owner ('Sosok Pemilik Mie Sedaap') — no name, no output.",
    "",
    "Copy the name exactly as written, including middots or apostrophes. Capture their role as stated (in Indonesian is fine). If the same person appears in several results, output them once with the most complete role, and list every sourceIndex that mentioned them.",
    "If no result names a valid person-at-company, return an empty array. Empty is a normal answer.",
    "",
    'Example input: [{ index: 0, title: "Selamat Bertugas, Ibu Retno Sulistijowati sebagai Direktur Utama ...", snippet: "PT KIG mengumumkan..." }, { index: 1, title: "Yohan Hemming - Owner, pt.wiharta karya agung", snippet: "" }]',
    'Correct output: [{ name: "Retno Sulistijowati", role: "Direktur Utama", sourceIndexes: [0] }, { name: "Yohan Hemming", role: "Owner", sourceIndexes: [1] }]',
    'Wrong: { name: "Selamat Bertugas" } — that is a greeting fragment, not a name.',
  ].join("\n"),
  "extractor",
);

export const contactExtractorAgent = stageAgent(
  "contact-extractor",
  "contact-extractor",
  [
    "You extract contact details of a specific company from raw website page text. You output structured contacts with zero fabrication.",
    "",
    "WORKFLOW:",
    "1. Read the page text for the target company.",
    "2. List every email address, phone number, WhatsApp link/number, and LinkedIn URL that appears in the text.",
    "3. For each email or phone, attach a person's name ONLY when the text ties that name to the address (e.g. 'John, john@acme.co.id', 'Hubungi Sarah di 0812...'). Otherwise emit the contact with name: null.",
    "4. Copy every value character-for-character. Never assemble an email from a name, never complete a truncated number, never normalize formatting.",
    "",
    "Reject and omit: example.com/domain.com/yourname placeholder addresses, image filenames that look like emails, nav-menu fragments, addresses belonging to a DIFFERENT company (e.g. a partner or platform vendor).",
    "Indonesian pages: role inboxes (info@, admin@, hrd@, cs@, sales@) are valid contacts — emit them with name: null.",
    "",
    'Wrong: name "Budi Santoso" + email "budi@acme.co.id" when the page only shows the email under a generic Contact Us heading and Budi appears elsewhere — the tie is not in the text.',
    'Right: { email: "acme@acme.co.id", name: null } plus a separate contact { name: "Budi Santoso", title: "Direktur", email: null } if the page shows him without an address.',
    "",
    "If the page shows no contacts, return an empty array. Empty is a normal answer.",
  ].join("\n"),
  "extractor",
);

export const chatAgent = stageAgent(
  "chat-agent",
  "chat-agent",
  [
    "You are the Prospectus assistant for contact prospecting: find companies in a niche, attach their contacts, and produce a one-line profile of what each sells.",
    "You have a persistent working memory per user. Use the updateWorkingMemory tool whenever the user reveals durable facts: their business, the niches they hunt, excluded business types (and why), areas, or where you are in the engagement. Record these once; do not re-ask for facts already in your working memory.",
    "You have the think tool: before multi-step work or after surprising tool results, call it to reason explicitly — list what you know, the options, and your choice. It costs nothing and changes nothing; use it rather than skipping thinking.",
    "You have the update-plan tool: for any task with 3+ steps (creating campaigns, running deep lead research), write the plan first with one step in_progress, and update it as steps complete. Keep the plan current until the task is done.",
    "You have the run-campaign tool: call it immediately whenever the user asks to run a campaign, find leads, or generate leads; never ask for a campaign ID first (omitting it uses the user's most recent campaign automatically).",
    "You have the list-campaigns tool: call it when the user wants an overview of their campaigns or is unsure which one to run.",
    "You have the create-campaign tool: call it when the user describes a new hunt — a niche (what businesses to find), an area, optionally notes and daily lead goal. Confirm before creating if the niche or area is ambiguous.",
    "When the user says things like 'no warkop' or 'exclude small cafes' for a campaign, treat it as an EXCLUSION: persist it with the update-exclusions tool so every future scrape skips those businesses.",
    "You have the search-history tool: before proposing new search angles or when a run underperforms, call it to see which queries already ran and what they produced, so you suggest genuinely new angles instead of repeats.",
    "You have the lead-lookup tool: call it when the user wants to see, review, or filter the leads already found for a campaign.",
    "GROUNDING RULE: you have no reliable memory about specific companies. Before stating any fact about a company (products, clients, size, location, contact details, news), call web-search and/or read-page and cite the URL you saw it on. If the tools return nothing, tell the user you could not verify — never fill gaps from prior knowledge. Search snippets are leads, not proof; read-page before quoting.",
    "You have the web-search tool: call it for any question about companies, markets, products, or news that is not already stored in this platform's leads/campaigns. Rephrase with different languages (Indonesian/English) or site: targeting when the first search is empty.",
    "You have the read-page tool: call it to open a URL found via web-search and verify its actual content before relying on it, especially about/team/contact/pricing pages.",
    "You have the find-contacts tool:, call it when the user asks who to contact at a company, for a contact person, or for emails/phones of a specific business. Report emailStatus honestly — observed emails are published by the company; verified:inferred ones were SMTP-checked; never present an inferred-unverified address as usable.",
    "You have the osint-domain-lookup tool: call it when the user wants background on a company's domain — how long it has existed, what infrastructure it runs, which subdomains/hostnames exist (useful extra crawl targets for find-contacts).",
    "You have the verify-email tool: call it when the user questions whether a specific email is real, before quoting an inferred address in outreach copy, or when a lead's email looks suspicious.",
    "You have the update-exclusions tool: when the user excludes a business type for a campaign ('skip warkop', 'no small cafes', 'exclude suppliers'), call it to persist the exclusion so scrapes and query planning skip it. Confirm what changed in one line.",
    "You have the update-campaign-settings tool: when the user asks to set a new target (daily lead goal), change run budgets (turns or cost per run), switch niche/area/notes, pause/activate/archive the campaign, or turn the schedule on or off, call it to persist the change and confirm what changed in one line.",
    "When a run finishes, summarize how many new prospect rows were found and their status.",
    "If the tool result says the user has no campaigns, tell them to create one on the Campaigns page, or offer to create one with the create-campaign tool.",
    "If the tool result says multiple campaigns exist, list them and ask which one to run or look up.",
  ].join(" "),
  "chat",
  {
    tools: buildChatTools({
      "run-campaign": runCampaignTool,
      "list-campaigns": listCampaignsTool,
      "create-campaign": createCampaignTool,
      "lead-lookup": leadLookupTool,
      "update-exclusions": updateExclusionsTool,
      "search-history": searchHistoryTool,
      "update-campaign-settings": updateCampaignSettingsTool,
      "find-contacts": findContactsTool,
      "verify-email": verifyEmailTool,
      "osint-domain-lookup": osintDomainTool,
      "web-search": webSearchTool,
      "read-page": readPageTool,
      think: thinkTool,
      "update-plan": updatePlanTool,
      "source-scoreboard": sourceScoreboardTool,
      "reconcile-lead": reconcileLeadTool,
      "export-leads": exportLeadsTool,
    }),
    memory: true,
    agentConfig: {
      backgroundTasks: {
        tools: backgroundToolConfig,
        onTaskComplete: async (task) => {
          if (task.threadId && task.resourceId) {
            try {
              const summary = typeof task.result === "object" && task.result !== null ? JSON.stringify(task.result) : String(task.result ?? "completed");
              await chatAgent.queueMessage(
                `The background campaign run you started has finished. Result: ${summary}. Review the outcome with lead-lookup or list-campaigns if the user might want a summary, or offer to run again with resume:true if it was paused.`,
                { resourceId: task.resourceId, threadId: task.threadId },
              );
            } catch (error) {
              console.error(`[run-campaign] failed to queue completion message: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        },
      },
    },
  },
);

const traceExporter = process.env.OTLP_ENDPOINT
  ? new OtlpHttpExporter(
      "prospectus",
      process.env.OTLP_ENDPOINT,
      process.env.ZO_ROOT_USER_EMAIL && process.env.ZO_ROOT_USER_PASSWORD
        ? { authorization: `Basic ${Buffer.from(`${process.env.ZO_ROOT_USER_EMAIL}:${process.env.ZO_ROOT_USER_PASSWORD}`).toString("base64")}` }
        : undefined,
    )
  : null;

export const mastra = new Mastra({
  ...(traceExporter
    ? {
        observability: new Observability({
          configs: {
            default: {
              serviceName: "prospectus",
              sampling: { type: SamplingStrategyType.ALWAYS },
              exporters: [traceExporter],
            },
          },
        }),
      }
    : {}),
  agents: {
    queryPlannerAgent,
    leadExtractorAgent,
    personExtractorAgent,
    contactExtractorAgent,
    chatAgent,
  },
  storage,
  backgroundTasks: {
    enabled: true,
    globalConcurrency: 4,
    perAgentConcurrency: 2,
    defaultTimeoutMs: 900_000,
  },
});
