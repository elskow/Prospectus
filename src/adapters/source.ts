import type { AdapterContext, AdapterCredentialRequirement } from "@src/adapters/common";

export interface CrawlInput {
  query: string;
  maxResults: number;
  viewport?: { lat: number; lng: number; zoom?: number } | null;
  detail?: "full" | "list";
}

export interface RawContactArtifact {
  name?: string | null;
  title?: string | null;
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  isDecisionMaker?: boolean | null;
}

export interface RawCompanyArtifact {
  name: string;
  address?: string | null;
  phone?: string | null;
  website?: string | null;
  city?: string | null;
  category?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
  sourceUrl?: string | null;
  title?: string | null;
  snippet?: string | null;
  contacts?: RawContactArtifact[] | null;
}

export const ARTIFACT_SCHEMA_VERSION = 1;

export interface CrawlResult {
  query: string;
  artifacts: RawCompanyArtifact[];
  sourceUrl?: string;
  warnings: string[];
  schemaVersion?: number;
}

export interface SourceAdapterDefinition {
  kind: "source";
  type: string;
  label: string;
  credentials: AdapterCredentialRequirement;

  crawl(input: CrawlInput, ctx: AdapterContext): Promise<CrawlResult>;
}
