import type { AdapterContext, AdapterCredentialRequirement } from "@src/adapters/common";

export interface WatchEvent {
  externalKey: string;
  type: string;
  payload: Record<string, unknown>;
}

export interface WatchResult {
  events: WatchEvent[];
  warnings: string[];
}

export interface WatchAdapterDefinition {
  kind: "watch";
  type: string;
  label: string;
  credentials: AdapterCredentialRequirement;

  poll(ctx: AdapterContext): Promise<WatchResult>;
}
