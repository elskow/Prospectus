import type { RawCompanyArtifact, SourceAdapterDefinition } from "@src/adapters/types";
import { MAPS_SOURCE_TYPE, crawlMaps, resolveMapsWebsite, setMapsWorkerEnv } from "@src/plugins/builtin/google-maps/worker";
import { definePlugin } from "@src/plugins/define";

const MAX_PLACE_LOOKUPS_PER_CRAWL = 40;
const PLACE_LOOKUP_BUDGET_MS = Number(process.env.MAPS_LOOKUP_BUDGET_MS ?? 120_000);

function externalWebsite(url: string | null): string | null {
  if (!url || /google\.|gstatic\.|googleapis\./.test(url)) return null;
  return url;
}

function cityFromAddress(address: string | null | undefined): string | null {
  if (!address) return null;
  const parts = address
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  for (const part of parts) {
    const named = part.match(/^(?:Kota|Kabupaten|Kab\.?|Kodya)\s+(.+)$/i);
    if (named?.[1]) return named[1].trim();
  }
  const cleaned = parts.map((part) => part.replace(/\b\d{4,6}\b/g, "").trim()).filter(Boolean);
  return cleaned.length >= 2 ? (cleaned[cleaned.length - 2] ?? null) : (cleaned[0] ?? null);
}

export const googleMapsPlugin = definePlugin({
  manifest: {
    name: "google-maps",
    description: "Scrapes Google Maps place listings via a Patchright worker subprocess, resolving websites from place detail pages.",
    schemaVersion: 1,
  },

  definition: {
    kind: "source",
    type: MAPS_SOURCE_TYPE,
    label: "Google Maps scraper",
    credentials: { fields: [] },

    crawl: async (input, ctx) => {
      const env: Record<string, string> = {};

      if (ctx.credentials.proxyUrl) env.SCRAPE_PROXY_URL = ctx.credentials.proxyUrl;
      if (ctx.credentials.geoLocale) env.SCRAPE_LOCALE = ctx.credentials.geoLocale;

      setMapsWorkerEnv(env);

      const result = await crawlMaps(input);
      for (const artifact of result.artifacts) {
        if (!artifact.city) artifact.city = cityFromAddress(artifact.address);
      }
      const needsLookup =
        input.detail === "list"
          ? []
          : result.artifacts.filter((artifact: RawCompanyArtifact) => (!artifact.website || artifact.reviewCount == null) && artifact.sourceUrl);

      if (needsLookup.length > 0) {
        const lookupBatch = needsLookup.slice(0, MAX_PLACE_LOOKUPS_PER_CRAWL);
        const warnings: string[] = [];
        const lookupStartedAt = Date.now();
        let resolvedCount = 0;
        for (const artifact of lookupBatch) {
          if (Date.now() - lookupStartedAt > PLACE_LOOKUP_BUDGET_MS) {
            warnings.push(
              `place lookups stopped after ${Math.round((Date.now() - lookupStartedAt) / 1000)}s (budget ${PLACE_LOOKUP_BUDGET_MS / 1000}s): ${lookupBatch.length - resolvedCount} unresolved`,
            );
            break;
          }
          try {
            const resolved = await resolveMapsWebsite(artifact.sourceUrl!);
            const website = externalWebsite(resolved.website);

            if (website) artifact.website = website;

            if (resolved.address && !artifact.address) artifact.address = resolved.address;
            if (resolved.rating != null && artifact.rating == null) artifact.rating = resolved.rating;
            if (resolved.reviewCount != null && artifact.reviewCount == null) artifact.reviewCount = resolved.reviewCount;
          } catch (error) {
            warnings.push(`website lookup failed for "${artifact.name}": ${error instanceof Error ? error.message : String(error)}`);
          }
          resolvedCount += 1;
        }

        for (const artifact of lookupBatch.slice(resolvedCount)) {
          warnings.push(`website lookup skipped (budget) for "${artifact.name}"`);
        }
        for (const artifact of needsLookup.slice(lookupBatch.length)) {
          warnings.push(`website lookup skipped (cap ${MAX_PLACE_LOOKUPS_PER_CRAWL}) for "${artifact.name}"`);
        }

        for (const artifact of result.artifacts) {
          if (!artifact.city) artifact.city = cityFromAddress(artifact.address);
        }

        result.warnings.push(...warnings);
      }

      return result;
    },
  } satisfies SourceAdapterDefinition,

  catalog: {
    type: MAPS_SOURCE_TYPE,
    kind: "source",
    label: "Google Maps scraper",
    credentialFields: [
      { name: "proxyUrl", label: "Residential proxy URL", secret: true, required: false },
      { name: "geoLocale", label: "Geo locale (e.g. id-ID)", secret: false, required: false },
    ],
  },
});
