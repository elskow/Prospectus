export interface ProspectusConfig {
  adapters: { type: string; enabled: boolean }[];
  directories?: {
    adapters: { id: string; enabled: boolean }[];
  };
}
