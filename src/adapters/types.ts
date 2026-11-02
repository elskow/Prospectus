import type { EnrichmentAdapterDefinition } from "@src/adapters/enrichment";
import type { SinkAdapterDefinition } from "@src/adapters/sink";
import type { SourceAdapterDefinition } from "@src/adapters/source";
import type { WatchAdapterDefinition } from "@src/adapters/watch";

export type { AdapterContext, AdapterCredentialRequirement } from "@src/adapters/common";

export type { CrawlInput, CrawlResult, RawCompanyArtifact, RawContactArtifact, SourceAdapterDefinition } from "@src/adapters/source";

export type { EnrichableCompany, EnrichedField, EnrichmentAdapterDefinition, EnrichmentResult } from "@src/adapters/enrichment";

export type { SinkAdapterDefinition, SinkLead, SinkResult } from "@src/adapters/sink";

export type { WatchAdapterDefinition, WatchEvent, WatchResult } from "@src/adapters/watch";

export type AdapterDefinition = SourceAdapterDefinition | WatchAdapterDefinition | EnrichmentAdapterDefinition | SinkAdapterDefinition;

export interface AdapterCatalogEntry {
  type: string;
  kind: AdapterDefinition["kind"];
  label: string;
  credentialFields: { name: string; label: string; secret: boolean; required: boolean }[];
}
