import type { SourceAdapterDefinition } from "@src/adapters/types";
import { SocialWorkerPool, type JobBoardSearchResult } from "@src/plugins/builtin/social/worker";
import { definePlugin } from "@src/plugins/define";

export const JOB_BOARDS_SOURCE_TYPE = "source:job-boards";

export async function searchJobs(query: string, location: string | null): Promise<JobBoardSearchResult> {
  const pool = new SocialWorkerPool("jobstreet", {
    SCRAPE_PROXY_URL: process.env.SCRAPE_PROXY_URL ?? "",
  });

  try {
    return await pool.searchJobs({ query, location });
  } finally {
    await pool.stop();
  }
}

export const jobBoardsPlugin = definePlugin({
  manifest: {
    name: "job-boards",
    description: "Searches public job postings on Jobstreet (falling back to Glints on bot-block) via a Patchright worker subprocess.",
    schemaVersion: 1,
  },

  definition: {
    kind: "source",
    type: JOB_BOARDS_SOURCE_TYPE,
    label: "Job Boards",
    credentials: {
      fields: ["proxyUrl"],
    },

    crawl: async (input, ctx) => {
      const pool = new SocialWorkerPool("jobstreet", {
        SCRAPE_PROXY_URL: ctx.credentials.proxyUrl ?? "",
      });

      try {
        const result = await pool.searchJobs({ query: input.query, location: null });
        const rolesWithCompany = result.firstPageRoles.filter((role): role is typeof role & { company: string } => Boolean(role.company));

        return {
          query: input.query,
          artifacts: rolesWithCompany.slice(0, input.maxResults).map((role) => ({
            name: role.company,
            category: role.title,
            city: role.location,
            sourceUrl: result.sourceUrl ?? null,
            contacts: [],
          })),
          sourceUrl: result.sourceUrl,
          warnings: result.warnings ?? [],
          schemaVersion: 1,
        };
      } finally {
        await pool.stop();
      }
    },
  } satisfies SourceAdapterDefinition,

  catalog: {
    type: JOB_BOARDS_SOURCE_TYPE,
    kind: "source",
    label: "Job Boards",
    credentialFields: [{ name: "proxyUrl", label: "Residential proxy URL", secret: true, required: false }],
  },
});
