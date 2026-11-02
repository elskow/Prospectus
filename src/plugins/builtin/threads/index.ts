import type { SourceAdapterDefinition } from "@src/adapters/types";
import { definePlugin } from "@src/plugins/define";
import { SocialWorkerPool } from "@src/plugins/builtin/social/worker";

export const THREADS_SOURCE_TYPE = "source:threads";

export const threadsPlugin = definePlugin({
  manifest: {
    name: "threads",
    description: "Searches Threads business posts via a Patchright worker subprocess using the user's sessionid cookie.",
    schemaVersion: 1,
  },

  definition: {
    kind: "source",
    type: THREADS_SOURCE_TYPE,
    label: "Threads",
    credentials: {
      fields: ["sessionId", "proxyUrl"],
    },

    crawl: async (input, ctx) => {
      const pool = new SocialWorkerPool("threads", {
        THREADS_SESSIONID: ctx.credentials.sessionId ?? "",
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
    type: THREADS_SOURCE_TYPE,
    kind: "source",
    label: "Threads",
    credentialFields: [
      { name: "sessionId", label: "Threads sessionid cookie", secret: true, required: true },
      { name: "proxyUrl", label: "Residential proxy URL", secret: true, required: false },
    ],
  },
});
