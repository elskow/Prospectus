import { z } from "zod";

export const leadContactSchema = z.object({
  name: z.string().nullish().describe("Person's name exactly as shown on the page; null when no name is present."),
  title: z.string().nullish().describe("Job title or role as shown; null when absent. Never infer a title from the name."),
  email: z.string().nullish().describe("Email address appearing verbatim in the source text; null when absent. Never construct or guess an email pattern."),
  phone: z.string().nullish().describe("Phone number appearing verbatim in the source text, with its original formatting; null when absent."),
  linkedinUrl: z.string().url().nullish().describe("LinkedIn profile or company URL appearing verbatim in the source text; null when absent."),
  isDecisionMaker: z
    .boolean()
    .nullish()
    .describe("True only when the title indicates ownership or management authority (owner, director, C-level, manager). Null when the title is unknown."),
});

export type LeadContact = z.infer<typeof leadContactSchema>;

export const leadCandidateSchema = z.object({
  name: z.string().min(1).describe("Business name exactly as displayed on the page or listing; never invent or normalize it."),
  address: z.string().nullish().describe("Street address as shown; null when absent. Do not assemble from fragments."),
  phone: z.string().nullish().describe("Business phone appearing verbatim in the source; null when absent."),
  website: z.string().url().nullish().describe("The business's own website URL; null when absent or when only a social media page exists."),
  city: z.string().nullish().describe("City the business operates in, as observable in the source; null when unclear."),
  province: z.string().nullish().describe("Province, state, or department the business operates in, as shown in the source; null when absent."),
  country: z.string().nullish().describe("Country the business operates in, as shown in the source; null when absent. Never infer it."),
  category: z.string().nullish().describe("Business category or industry as shown in the source; null when unclear."),
  rating: z.number().min(0).max(5).nullish().describe("Rating value shown in the source; null when no rating is displayed."),
  reviewCount: z.number().int().nonnegative().nullish().describe("Number of reviews shown in the source; null when not displayed."),
  productsServices: z.array(z.string()).nullish().describe("Products or services explicitly offered on the page; null when none are listed."),
  contacts: z
    .array(leadContactSchema)
    .nullish()
    .describe("Named people with contact details found on the page; null when no people are mentioned. Every field must be observed verbatim or null."),
  sourceUrl: z.string().nullish(),
  raw: z.record(z.string(), z.unknown()).nullish(),
});

export type LeadCandidate = z.infer<typeof leadCandidateSchema>;

export const campaignSpecSchema = z.object({
  niche: z.string().min(1).describe("What kind of businesses to hunt, e.g. 'konsultan pajak' or 'pabrik furniture'"),
  area: z.string().nullish().describe("Geography to search within, e.g. 'Surabaya' or 'Jabodetabek'"),
  notes: z.string().nullish().describe("Free-text guidance for query planning, never gates"),
});

export type CampaignSpec = z.infer<typeof campaignSpecSchema>;

export const queryPlanSchema = z.object({
  queries: z
    .array(z.string().min(1))
    .min(1)
    .max(10)
    .describe("Six to ten search queries; each a specific, self-contained query in the campaign's search language."),
  rationale: z.string().describe("One sentence explaining how these queries cover the niche and area."),
});

export type QueryPlan = z.infer<typeof queryPlanSchema>;

export const expansionSchema = z.object({
  expansions: z
    .array(z.string().min(1))
    .min(1)
    .max(4)
    .describe("One to four alternative queries, each with a DIFFERENT core business-type concept from the original and from each other."),
});

export type Expansion = z.infer<typeof expansionSchema>;

export const extractionSchema = z.object({
  candidates: z.array(leadCandidateSchema).describe("Businesses observed in the source text. Every field is either observed verbatim or null — never guessed."),
  droppedCount: z.number().int().nonnegative().describe("Count of businesses you chose not to include, e.g. duplicates or entries without a name."),
});

export type ExtractionResult = z.infer<typeof extractionSchema>;

export const pageContactExtractionSchema = z.object({
  contacts: z
    .array(
      z.object({
        name: z.string().nullish().describe("Person's name exactly as written in the source text; null for role inboxes and company-level contacts."),
        title: z.string().nullish().describe("Job title as written in the source text; null when absent."),
        email: z.string().nullish().describe("Email address copied character-for-character from the source text; null when the page shows no email."),
        phone: z.string().nullish().describe("Phone number as written in the source text; null when absent."),
        whatsapp: z.string().nullish().describe("WhatsApp number or wa.me link as written; null when absent."),
        linkedinUrl: z.string().nullish().describe("LinkedIn URL copied verbatim; null when absent."),
      }),
    )
    .describe(
      "Every contact visible in the source text. Empty array when the page shows none. Copy values character-for-character; never assemble, guess, or complete partial values.",
    ),
});

export type PageContactExtraction = z.infer<typeof pageContactExtractionSchema>;

export const personMentionSchema = z.object({
  people: z
    .array(
      z.object({
        name: z.string().describe("Personal name exactly as written in the source text."),
        role: z.string().nullish().describe("Role/job title as stated, e.g. 'Direktur Utama'. Null when the text gives no role."),
        sourceIndexes: z.array(z.number().int()).nullish().describe("Indexes of the search results that mention this person."),
      }),
    )
    .describe("Named people holding a role at the target company. Empty array when none found."),
});

export type PersonMentionResult = z.infer<typeof personMentionSchema>;
