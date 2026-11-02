import type { AdapterContext, AdapterCredentialRequirement } from "@src/adapters/common";

export interface EnrichableCompany {
  companyId: string;
  name: string;
  website: string | null;
  city: string | null;
}

export interface EnrichedField {
  field: string;
  value: unknown;
  stage: string;
  confidence: number;
}

export interface EnrichmentResult {
  status: "complete" | "partial" | "failed";
  enrichedFields: EnrichedField[];
  rawArtifact?: unknown;
  warnings: string[];
}

export interface EnrichmentAdapterDefinition {
  kind: "enrichment";
  type: string;
  label: string;
  credentials: AdapterCredentialRequirement;

  enrich(company: EnrichableCompany, ctx: AdapterContext): Promise<EnrichmentResult>;
}
