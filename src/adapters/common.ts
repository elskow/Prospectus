export interface AdapterCredentialRequirement {
  fields: string[];
}

export interface AdapterContext {
  userId: string;
  runId: string | null;
  credentials: Record<string, string>;
}
