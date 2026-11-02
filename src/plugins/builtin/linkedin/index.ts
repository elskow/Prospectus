import type { SourceAdapterDefinition } from "@src/adapters/types";
import { definePlugin } from "@src/plugins/define";
import { SocialWorkerPool, type DiscoveredPerson } from "@src/plugins/builtin/social/worker";

export const LINKEDIN_SOURCE_TYPE = "source:linkedin";

export async function discoverPeople(companyName: string, city: string | null, credentials: { liAt: string; proxyUrl?: string }): Promise<DiscoveredPerson[]> {
  const pool = new SocialWorkerPool("linkedin", {
    LINKEDIN_LI_AT: credentials.liAt,
    SCRAPE_PROXY_URL: credentials.proxyUrl ?? "",
  });

  try {
    return await pool.discoverPeople(companyName, city);
  } finally {
    await pool.stop();
  }
}

export async function discoverCompanyPeople(companyUrl: string, credentials: { liAt: string; proxyUrl?: string }, maxResults = 8): Promise<DiscoveredPerson[]> {
  const pool = new SocialWorkerPool("linkedin", {
    LINKEDIN_LI_AT: credentials.liAt,
    SCRAPE_PROXY_URL: credentials.proxyUrl ?? "",
  });

  try {
    return await pool.discoverCompanyPeople(companyUrl, maxResults);
  } finally {
    await pool.stop();
  }
}

export const linkedinPlugin = definePlugin({
  manifest: {
    name: "linkedin",
    description: "Searches LinkedIn company and people results via a Patchright worker subprocess using the user's li_at session cookie.",
    schemaVersion: 1,
  },

  definition: {
    kind: "source",
    type: LINKEDIN_SOURCE_TYPE,
    label: "LinkedIn",
    credentials: {
      fields: ["liAt", "proxyUrl"],
    },

    crawl: async (input, ctx) => {
      const pool = new SocialWorkerPool("linkedin", {
        LINKEDIN_LI_AT: ctx.credentials.liAt ?? "",
        SCRAPE_PROXY_URL: ctx.credentials.proxyUrl ?? "",
      });

      try {
        return await pool.crawl(input);
      } finally {
        await pool.stop();
      }
    },
  } satisfies SourceAdapterDefinition,

  catalog: {
    type: LINKEDIN_SOURCE_TYPE,
    kind: "source",
    label: "LinkedIn",
    credentialFields: [
      { name: "liAt", label: "LinkedIn li_at session cookie", secret: true, required: true },
      { name: "proxyUrl", label: "Residential proxy URL", secret: true, required: false },
    ],
  },
});
