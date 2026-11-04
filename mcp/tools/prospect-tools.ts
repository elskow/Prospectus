import { and, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@src/db";
import { campaigns, companies, contacts, leads, runEvents, runs, suppressions } from "@src/db/schema";
import { dedupeKeyFor, ensureSource, invalidateSuppressionCache, persistCandidates } from "@src/harness/persistence";
import { domainHasMailInfrastructure } from "@src/harness/osint-contacts";
import { isRoleEmail, websiteMatchesCompany } from "@src/harness/contact-discovery";
import { extractEmails } from "@src/harness/site-crawl/extract";
import { campaignNotFound, invalidArguments, ToolError } from "../errors";
import { campaignFor, decodeCursor, encodeCursor, resolveUserId, type ToolDefinition } from "./shared";

export async function runProspectTools(): Promise<ToolDefinition[]> {
  return [
    {
      name: "export_prospects",
      description:
        "Export a campaign's prospects as CSV text (company, city, country, website, email, status). Use emailOnly to export only companies with an email address, country to export one country. Page with cursor: pass the previous nextCursor.",
      schema: z.object({
        campaignId: z.string().uuid().optional(),
        emailOnly: z.boolean().optional(),
        country: z.string().min(2).max(80).optional(),
        limit: z.number().int().min(1).max(5000).optional(),
        cursor: z.string().max(400).optional(),
      }),
      handler: async (input) => {
        const parsed = z
          .object({
            campaignId: z.string().uuid().optional(),
            emailOnly: z.boolean().optional(),
            country: z.string().min(2).max(80).optional(),
            limit: z.number().int().min(1).max(5000).optional(),
            cursor: z.string().max(400).optional(),
          })
          .parse(input);
        const userId = await resolveUserId();
        const campaign = await campaignFor(userId, parsed.campaignId);
        const limit = parsed.limit ?? 500;
        const after = decodeCursor(parsed.cursor);

        const rows = (await db.execute(sql`
          select c.id, c.name, coalesce(c.city, '') as city, coalesce(c.country, '') as country, coalesce(c.website, '') as website,
                 coalesce((select k.email from contacts k where k.company_id = c.id and k.email is not null
                           order by (k.is_decision_maker is true) desc, (k.name is not null) desc, (k.email_verification is not null) desc, k.created_at
                           limit 1), '') as email,
                 l.status
          from companies c
          join leads l on l.company_id = c.id
          where l.campaign_id = ${campaign.id}
            ${parsed.emailOnly ? sql`and exists (select 1 from contacts k where k.company_id = c.id and k.email is not null)` : sql``}
            ${parsed.country ? sql`and c.country = ${parsed.country}` : sql``}
            ${after ? sql`and (c.name, c.id) > (${after.name}, ${after.id})` : sql``}
          order by c.name, c.id
          limit ${limit + 1}
        `)) as unknown as { id: string; name: string; city: string; country: string; website: string; email: string; status: string }[];

        const suppressedEmails = new Set(
          (await db.select({ email: suppressions.email }).from(suppressions))
            .map((row) => row.email?.toLowerCase())
            .filter((email): email is string => Boolean(email)),
        );
        const suppressedDomains = new Set(
          (await db.select({ domain: suppressions.domain }).from(suppressions))
            .map((row) => row.domain?.toLowerCase())
            .filter((domain): domain is string => Boolean(domain)),
        );
        const usable = rows.filter((row) => {
          const email = row.email.toLowerCase();
          if (!email) return true;
          if (suppressedEmails.has(email)) return false;
          return !suppressedDomains.has(email.split("@")[1] ?? "");
        });

        const page = usable.slice(0, limit);
        const nextCursor = rows.length > limit ? encodeCursor((page[page.length - 1] ?? rows[limit - 1])!) : null;

        const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
        const lines = ["company,city,country,website,email,status"];
        for (const row of page) {
          lines.push([row.name, row.city, row.country, row.website, row.email, row.status].map(escape).join(","));
        }

        return { campaignId: campaign.id, rowCount: lines.length - 1, nextCursor, csv: lines.join("\n") };
      },
    },
    {
      name: "import_list",
      description:
        "Import a list the user already has (rows with name and optionally email/phone/website/city). Deduplicates against existing companies and returns a verdict per row: imported, exists, or skipped. Rows are stored with provenance source:manual-import.",
      schema: z.object({
        campaignId: z.string().uuid().optional(),
        rows: z
          .array(
            z.object({
              name: z.string().min(2).max(200),
              email: z.string().email().optional(),
              phone: z.string().max(40).optional(),
              website: z.string().url().optional(),
              city: z.string().max(120).optional(),
              category: z.string().max(160).optional(),
            }),
          )
          .min(1)
          .max(500),
      }),
      handler: async (input) => {
        const parsed = z
          .object({
            campaignId: z.string().uuid().optional(),
            rows: z
              .array(
                z.object({
                  name: z.string().min(2).max(200),
                  email: z.string().email().optional(),
                  phone: z.string().max(40).optional(),
                  website: z.string().url().optional(),
                  city: z.string().max(120).optional(),
                  category: z.string().max(160).optional(),
                }),
              )
              .min(1)
              .max(500),
          })
          .parse(input);
        const userId = await resolveUserId();
        const campaign = await campaignFor(userId, parsed.campaignId);

        const insertedRun = await db
          .insert(runs)
          .values({
            campaignId: campaign.id,
            status: "succeeded",
            trigger: "manual",
            finishedAt: new Date(),
            result: { status: "succeeded", reason: "import:list", turnsUsed: 0, newReadyLeads: 0, totalReadyLeads: 0 },
          })
          .returning({ id: runs.id });
        const run = insertedRun[0];
        if (!run) throw new ToolError("INTERNAL", "failed to record the import run; retry import_list");

        const sourceId = await ensureSource("source:manual-import", "provided list");
        const candidates = parsed.rows.map((row) => ({
          name: row.name,
          phone: row.phone ?? null,
          website: row.website ?? null,
          city: row.city ?? null,
          category: row.category ?? null,
          contacts: row.email ? [{ name: null, title: null, email: row.email.toLowerCase(), phone: null, linkedinUrl: null, isDecisionMaker: null }] : null,
          sourceUrl: row.website ?? null,
        }));

        const verdicts: { name: string; status: "imported" | "exists" | "skipped"; companyId?: string }[] = [];
        const fresh = [];
        for (const candidate of candidates) {
          const key = dedupeKeyFor(candidate);
          let [existing] = await db.select({ id: companies.id }).from(companies).where(eq(companies.dedupeKey, key)).limit(1);
          if (!existing) {
            [existing] = await db
              .select({ id: companies.id })
              .from(companies)
              .where(sql`lower(${companies.name}) = ${candidate.name.toLowerCase()}`)
              .limit(1);
          }
          if (existing) verdicts.push({ name: candidate.name, status: "exists", companyId: existing.id });
          else {
            verdicts.push({ name: candidate.name, status: "imported" });
            fresh.push(candidate);
          }
        }

        const persisted =
          fresh.length > 0
            ? await persistCandidates({ campaignId: campaign.id, runId: run.id, sourceId, candidates: fresh })
            : { newCompanies: 0, newLeads: 0, duplicates: 0 };
        const skipped = verdicts.filter((verdict) => verdict.status === "imported").length - persisted.newCompanies;
        for (let index = verdicts.length - 1; index >= 0 && skipped > 0; index -= 1) {
          if (verdicts[index]?.status !== "imported") continue;
          verdicts[index] = { name: verdicts[index]!.name, status: "skipped" };
        }

        return {
          campaignId: campaign.id,
          requested: parsed.rows.length,
          imported: persisted.newCompanies,
          leads: persisted.newLeads,
          exists: verdicts.filter((verdict) => verdict.status === "exists").length,
          rows: verdicts,
        };
      },
    },
    {
      name: "import_suppressions",
      description:
        "Record do-not-contact entries so Prospectus never exports them again. Accepts exact emails and/or whole domains, e.g. from the CRM after sending. Applied to exports and lead rows.",
      schema: z.object({
        emails: z.array(z.string().email()).max(500).optional(),
        domains: z.array(z.string().min(3).max(120)).max(500).optional(),
        reason: z.string().max(200).optional(),
        source: z.string().max(80).optional(),
      }),
      handler: async (input) => {
        const parsed = z
          .object({
            emails: z.array(z.string().email()).max(500).optional(),
            domains: z.array(z.string().min(3).max(120)).max(500).optional(),
            reason: z.string().max(200).optional(),
            source: z.string().max(80).optional(),
          })
          .parse(input);
        const emails = [...new Set((parsed.emails ?? []).map((email) => email.trim().toLowerCase()))];
        const domains = [
          ...new Set(
            (parsed.domains ?? []).map((domain) =>
              domain
                .trim()
                .toLowerCase()
                .replace(/^www\./, ""),
            ),
          ),
        ];
        if (emails.length === 0 && domains.length === 0) throw invalidArguments("pass emails or domains");

        let inserted = 0;
        if (emails.length > 0) {
          const rows = await db
            .insert(suppressions)
            .values(emails.map((email) => ({ email, reason: parsed.reason ?? null, source: parsed.source ?? "manual" })))
            .onConflictDoNothing()
            .returning({ id: suppressions.id });
          inserted += rows.length;
        }
        for (const domain of domains) {
          const rows = await db
            .insert(suppressions)
            .values({ domain, reason: parsed.reason ?? null, source: parsed.source ?? "manual" })
            .onConflictDoNothing()
            .returning({ id: suppressions.id });
          inserted += rows.length;
        }
        invalidateSuppressionCache();
        return { requested: emails.length + domains.length, inserted };
      },
    },
    {
      name: "check_contacts",
      description:
        "Validate a batch of emails and check whether Prospectus already has them: format, domain, MX, role/personal, and existing contact/company/campaign matches.",
      schema: z.object({ emails: z.array(z.string().min(3).max(200)).min(1).max(200) }),
      handler: async (input) => {
        const { emails } = z.object({ emails: z.array(z.string().min(3).max(200)).min(1).max(200) }).parse(input);
        const normalized = [...new Set(emails.map((email) => email.trim().toLowerCase()))];

        const found = await db
          .select({
            email: contacts.email,
            companyId: companies.id,
            companyName: companies.name,
            website: companies.website,
            country: companies.country,
            leadStatus: leads.status,
            campaignId: leads.campaignId,
          })
          .from(contacts)
          .innerJoin(companies, eq(companies.id, contacts.companyId))
          .leftJoin(leads, eq(leads.companyId, companies.id))
          .where(sql`lower(${contacts.email}) in ${sql.raw(`(${normalized.map((email) => `'${email.replace(/'/g, "''")}'`).join(",")})`)}`);

        const byEmail = new Map<string, typeof found>();
        for (const row of found) {
          if (!row.email) continue;
          const list = byEmail.get(row.email.toLowerCase()) ?? [];
          list.push(row);
          byEmail.set(row.email.toLowerCase(), list);
        }

        const results = [];
        const domainCache = new Map<string, boolean>();
        const domains = [...new Set(normalized.map((email) => email.split("@")[1] ?? "").filter(Boolean))];
        const queue = [...domains];
        await Promise.all(
          Array.from({ length: Math.min(10, queue.length) }, async () => {
            while (queue.length > 0) {
              const domain = queue.shift();
              if (!domain) return;
              domainCache.set(domain, await domainHasMailInfrastructure(domain).catch(() => false));
            }
          }),
        );

        for (const email of normalized) {
          const domain = email.split("@")[1] ?? "";
          const formatOk = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email);
          const mxLive = formatOk && domain ? (domainCache.get(domain) ?? false) : false;
          const matches = byEmail.get(email) ?? [];
          results.push({
            email,
            formatOk,
            domain,
            mxLive,
            role: isRoleEmail(email),
            alreadyInDb: matches.length > 0,
            company: matches[0] ? { id: matches[0].companyId, name: matches[0].companyName, website: matches[0].website, country: matches[0].country } : null,
            campaigns: matches.map((match) => ({ campaignId: match.campaignId, leadStatus: match.leadStatus })),
          });
        }
        return { checked: results.length, results };
      },
    },
    {
      name: "lookup_company",
      description:
        "Look up whether a company is already known: by name, website domain, or contact email. Returns the record, its emails, and the campaigns it appears in.",
      schema: z.object({ name: z.string().max(200).optional(), domain: z.string().max(160).optional(), email: z.string().max(200).optional() }),
      handler: async (input) => {
        const parsed = z
          .object({ name: z.string().max(200).optional(), domain: z.string().max(160).optional(), email: z.string().max(200).optional() })
          .parse(input);
        if (!parsed.name && !parsed.domain && !parsed.email) throw invalidArguments("pass name, domain or email");

        const rows = await db
          .select({
            companyId: companies.id,
            name: companies.name,
            website: companies.website,
            city: companies.city,
            country: companies.country,
            address: companies.address,
            category: companies.industryCategory,
            email: contacts.email,
          })
          .from(companies)
          .leftJoin(contacts, eq(contacts.companyId, companies.id))
          .where(
            parsed.email
              ? sql`lower(${contacts.email}) = ${parsed.email.toLowerCase()}`
              : parsed.domain
                ? sql`(${companies.website} ilike ${`%${parsed.domain}%`} or lower(${contacts.email}) like ${`%@${parsed.domain.toLowerCase()}`})`
                : sql`${companies.name} ilike ${`%${parsed.name}%`}`,
          )
          .limit(20);

        if (rows.length === 0) return { found: false, companies: [] };
        const companyIds = [...new Set(rows.map((row) => row.companyId))];
        const leadRows = await db
          .select({ companyId: leads.companyId, campaignId: leads.campaignId, status: leads.status, createdAt: leads.createdAt })
          .from(leads)
          .where(sql`${leads.companyId} in ${sql.raw(`('${companyIds.join("','")}')`)}`);

        const byCompany = new Map<string, typeof rows>();
        for (const row of rows) {
          const list = byCompany.get(row.companyId) ?? [];
          list.push(row);
          byCompany.set(row.companyId, list);
        }

        return {
          found: true,
          companies: [...byCompany.entries()].map(([companyId, list]) => ({
            id: companyId,
            name: list[0]?.name,
            website: list[0]?.website,
            city: list[0]?.city,
            country: list[0]?.country,
            address: list[0]?.address,
            category: list[0]?.category,
            emails: [...new Set(list.map((row) => row.email).filter((email): email is string => Boolean(email)))],
            leads: leadRows.filter((lead) => lead.companyId === companyId),
          })),
        };
      },
    },
    {
      name: "enrich_from_url",
      description:
        "Given a website URL, crawl its contact/about pages and extract every email found. Returns the addresses; with campaignId and persist=true it also attaches them to a company record.",
      schema: z.object({ url: z.string().url(), campaignId: z.string().uuid().optional(), persist: z.boolean().optional() }),
      handler: async (input) => {
        const parsed = z.object({ url: z.string().url(), campaignId: z.string().uuid().optional(), persist: z.boolean().optional() }).parse(input);
        const origin = new URL(parsed.url).origin;
        const pages = [parsed.url, `${origin}/kontak`, `${origin}/hubungi-kami`, `${origin}/contact`, `${origin}/about`];

        const emails = new Set<string>();
        let pagesRead = 0;
        const fetched = await Promise.all(
          [...new Set(pages)].map(async (page) => {
            try {
              const response = await fetch(page, { headers: { "user-agent": "Mozilla/5.0 Chrome/156" }, signal: AbortSignal.timeout(12_000) });
              if (!response.ok) return null;
              return await response.text();
            } catch {
              return null;
            }
          }),
        );
        for (const html of fetched) {
          if (!html) continue;
          pagesRead += 1;
          for (const email of extractEmails(html).emails) {
            const lower = email.toLowerCase();
            if (lower.endsWith(".png") || lower.endsWith(".jpg")) continue;
            emails.add(lower);
          }
        }

        const found = [...emails];
        if (!parsed.persist || !parsed.campaignId || found.length === 0) {
          return { url: parsed.url, pagesRead, emails: found, persisted: false };
        }

        const userId = await resolveUserId();
        const campaign = await campaignFor(userId, parsed.campaignId);
        const hostname = new URL(parsed.url).hostname.replace(/^www\./, "");
        const name = hostname.split(".")[0] ?? hostname;
        const insertedRun = await db
          .insert(runs)
          .values({
            campaignId: campaign.id,
            status: "succeeded",
            trigger: "manual",
            finishedAt: new Date(),
            result: { status: "succeeded", reason: "enrich:url", turnsUsed: 0, newReadyLeads: 0, totalReadyLeads: 0 },
          })
          .returning({ id: runs.id });
        const run = insertedRun[0];
        if (!run) throw new ToolError("INTERNAL", "failed to record the enrichment run; retry enrich_from_url");
        const sourceId = await ensureSource("source:url-enrich", parsed.url);
        const persisted = await persistCandidates({
          campaignId: campaign.id,
          runId: run.id,
          sourceId,
          candidates: [
            {
              name,
              website: origin,
              contacts: found.map((email) => ({ name: null, title: null, email, phone: null, linkedinUrl: null, isDecisionMaker: null })),
              sourceUrl: parsed.url,
            },
          ],
        });

        return { url: parsed.url, pagesRead, emails: found, persisted: true, company: persisted.newCompanies > 0 ? "created" : "existing" };
      },
    },
  ];
}
