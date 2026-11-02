export type { WebResult, BackendKey } from "@src/harness/websearch/types";
export { loadSearchSettings, invalidateSearchSettingsCache } from "@src/harness/websearch/settings";
export { fetchWebResults } from "@src/harness/websearch/orchestrator";
export {
  probeCompanyIdentity,
  findCompanyWebsite,
  findCompanyProfilePdf,
  companyFromWebTitle,
  crossValidateCandidate,
  type DeepWebEvidence,
} from "@src/harness/websearch/intel";
