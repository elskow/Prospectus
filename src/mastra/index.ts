import type { AgentConfig } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm/model/shared.types";
import { Agent } from "@mastra/core/agent";
import { Mastra } from "@mastra/core/mastra";
import { PromptInjectionDetector, UnicodeNormalizer } from "@mastra/core/processors";
import { gatewayChatModel } from "@src/lib/llm-gateway";
import { ExtractionVerifier } from "@src/mastra/processors/lead-guardrails";
import { getModelSelection, type StageKey } from "@src/lib/model-settings";
import { Observability, SamplingStrategyType } from "@mastra/observability";
import { OtlpHttpExporter } from "@src/harness/otel-exporter";

export const modelForId = async (modelRef: string): Promise<MastraModelConfig> => (await gatewayChatModel(modelRef)) as unknown as MastraModelConfig;

const detectorModelConfig = (async () => gatewayChatModel((await getModelSelection()).planner)) as unknown as MastraModelConfig;

const resolveStageModel = (stage: StageKey) => async () => gatewayChatModel((await getModelSelection())[stage]);

function stageAgent(
  id: string,
  name: string,
  instructions: string,
  stage: StageKey,
  options?: { tools?: Record<string, unknown>; agentConfig?: Partial<AgentConfig> },
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
  },
});
