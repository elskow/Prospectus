import type { AdapterContext, AdapterCredentialRequirement } from "@src/adapters/common";

export interface SinkLead {
  companyName: string;
  city: string | null;
  website: string | null;
  contactName: string | null;
  contactTitle: string | null;
  contactEmail: string | null;
  emailVerification: string | null;
  contactPhone: string | null;
  contactWhatsapp: string | null;
  isDecisionMaker: boolean | null;
  sourceUrl: string | null;
  discoveredAt: string | null;
}

export interface SinkResult {
  written: number;
  targetLocation: string;
  warnings: string[];
}

export interface SinkAdapterDefinition {
  kind: "sink";
  type: string;
  label: string;
  credentials: AdapterCredentialRequirement;

  write(leads: SinkLead[], ctx: AdapterContext): Promise<SinkResult>;
}
