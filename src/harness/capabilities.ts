export interface CapabilityContext {
  userId: string;
  campaignId: string | null;
  hasActiveRun: boolean;
  hasSink: boolean;
  hasCredentials: (adapterType: string) => boolean;
}
