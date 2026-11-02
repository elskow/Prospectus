import type { SourceAdapterDefinition } from "@src/adapters/types";
import { definePlugin } from "@src/plugins/define";
import { SocialWorkerPool } from "@src/plugins/builtin/social/worker";

export const INSTAGRAM_SOURCE_TYPE = "source:instagram";

export const instagramPlugin = definePlugin({
  manifest: {
    name: "instagram",
    description: "Finds Instagram business profiles via search and extracts bio contacts (WA phone, email, external website) from public profiles.",
    schemaVersion: 1,
  },

  definition: {
    kind: "source",
    type: INSTAGRAM_SOURCE_TYPE,
    label: "Instagram",
    credentials: { fields: ["proxyUrl"] },

    crawl: async (input, ctx) => {
      const pool = new SocialWorkerPool("instagram", {
        SCRAPE_PROXY_URL: ctx.credentials.proxyUrl ?? "",
        SCRAPE_LOCALE: ctx.credentials.geoLocale ?? "id-ID",
      });

      try {
        return await pool.crawl(input);
      } finally {
        await pool.stop();
      }
    },
  } satisfies SourceAdapterDefinition,

  catalog: {
    type: INSTAGRAM_SOURCE_TYPE,
    kind: "source",
    label: "Instagram",
    credentialFields: [
      { name: "proxyUrl", label: "Residential proxy URL", secret: true, required: false },
      { name: "geoLocale", label: "Geo locale (e.g. id-ID)", secret: false, required: false },
    ],
  },
});
