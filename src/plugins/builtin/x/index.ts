import type { SourceAdapterDefinition } from "@src/adapters/types";
import { definePlugin } from "@src/plugins/define";
import { SocialWorkerPool } from "@src/plugins/builtin/social/worker";

export const X_SOURCE_TYPE = "source:x";

export const xPlugin = definePlugin({
  manifest: {
    name: "x",
    description: "Searches X (Twitter) posts and accounts via a Patchright worker subprocess using auth_token + ct0 session cookies.",
    schemaVersion: 1,
  },

  definition: {
    kind: "source",
    type: X_SOURCE_TYPE,
    label: "X (Twitter)",
    credentials: {
      fields: ["authToken", "ct0", "proxyUrl"],
    },

    crawl: async (input, ctx) => {
      const pool = new SocialWorkerPool("x", {
        X_AUTH_TOKEN: ctx.credentials.authToken ?? "",
        X_CT0: ctx.credentials.ct0 ?? "",
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
    type: X_SOURCE_TYPE,
    kind: "source",
    label: "X (Twitter)",
    credentialFields: [
      { name: "authToken", label: "X auth_token cookie", secret: true, required: true },
      { name: "ct0", label: "X ct0 cookie", secret: true, required: true },
      { name: "proxyUrl", label: "Residential proxy URL", secret: true, required: false },
    ],
  },
});
