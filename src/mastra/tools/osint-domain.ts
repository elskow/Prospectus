import { createTool } from "@mastra/core/tools";
import { osintDomainLookup } from "@src/harness/osint";
import { z } from "zod";

export const osintDomainTool = createTool({
  id: "osint-domain-lookup",
  description:
    "Open-source intelligence on a company's domain: WHOIS via RDAP (registrar, registration age, expiry), certificate-transparency subdomains (crt.sh), and live DNS (A, MX, TXT/SPF, DMARC, mail provider). Use it to gauge whether a company is established, find infrastructure signals for qualification, or discover additional hostnames worth crawling for contacts.",
  inputSchema: z.object({
    domain: z.string().min(1).describe("Domain or website URL, e.g. acme.co.id or https://www.acme.co.id"),
  }),

  execute: async (inputData) => {
    const report = await osintDomainLookup(inputData.domain);
    return { ok: true as const, ...report };
  },
});
