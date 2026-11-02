import type { ResearchDeps } from "@src/harness/research-deps";
import { findDecisionMakersOnWeb } from "@src/harness/decision-maker";
import { discoverPeople } from "@src/plugins/builtin/linkedin";
import { findCompanyNews } from "@src/harness/news";
import { crossValidateCandidate, findCompanyProfilePdf, findCompanyWebsite, probeCompanyIdentity } from "@src/harness/websearch";
import { fetchDeepSiteContent } from "@src/harness/site-content";

export const defaultResearchDeps: ResearchDeps = {
  probeIdentity: (candidate) => probeCompanyIdentity(candidate.name, candidate.city ?? null),
  findWebsite: (candidate) => findCompanyWebsite(candidate.name, candidate.city ?? null),
  fetchSiteContent: (website) => fetchDeepSiteContent(website).then((r) => r.content),
  findProfilePdf: (candidate) => findCompanyProfilePdf(candidate.name, candidate.city ?? null),
  news: (name) => findCompanyNews(name),
  crossValidate: (candidate) => crossValidateCandidate(candidate.name, candidate.city ?? null),
  decisionMakers: async (candidate, linkedin) => {
    const webPeople = await findDecisionMakersOnWeb(candidate.name, candidate.city ?? null);
    if (webPeople.length > 0) {
      return webPeople.map((person) => ({ name: person.name, title: person.title, linkedinUrl: person.linkedinUrl }));
    }
    if (linkedin) {
      const people = await discoverPeople(candidate.name, candidate.city ?? null, {
        liAt: linkedin.liAt,
        proxyUrl: linkedin.proxyUrl ?? undefined,
      });
      return people.map((person) => ({ name: person.name, title: person.title, linkedinUrl: person.linkedinUrl }));
    }
    return [];
  },
};
