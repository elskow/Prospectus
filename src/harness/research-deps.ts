import type { LeadCandidate } from "@src/harness/schemas";
import type { DeepWebEvidence } from "@src/harness/websearch";
export interface LinkedInCredentials {
  liAt: string;
  proxyUrl?: string | null;
}

export type DecisionMaker = { name: string | null; title: string | null; linkedinUrl: string | null };

export type NewsHeadline = { title: string; link: string };

export interface ResearchDeps {
  probeIdentity(candidate: LeadCandidate): Promise<{ verified: boolean } | null>;
  findWebsite(candidate: LeadCandidate): Promise<string | null>;
  fetchSiteContent(website: string): Promise<string | null>;
  findProfilePdf(candidate: LeadCandidate): Promise<{ url: string; excerpt: string } | null>;
  news(name: string): Promise<NewsHeadline | null>;
  crossValidate(candidate: LeadCandidate): Promise<DeepWebEvidence[] | null>;
  decisionMakers(candidate: LeadCandidate, linkedin: LinkedInCredentials | null): Promise<DecisionMaker[] | null>;
}
