import { eq, and, isNull, isNotNull } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "@src/db";
import { contacts, suppressions, type HuntTargetOutcome } from "@src/db/schema";
import { guessPersonalEmails, inferEmailPattern, websiteMatchesCompany } from "@src/harness/contact-discovery";
import { domainHasMailInfrastructure, harvestPersonEmailEvidence } from "@src/harness/osint-contacts";
import { learnRolePrefixes } from "@src/harness/email-vocabulary";
import { verifyEmailRemote } from "@src/harness/email-verifier";
import { refreshCompanyEmailFlag } from "@src/harness/persistence";
import type { HarnessTracer } from "@src/harness/tracer";

export interface EmailBackfillTarget {
  companyId: string;
  companyName: string;
  website: string;
}

export interface NamedContactRow {
  id: string;
  name: string | null;
  email: string | null;
}

interface ProgressSink {
  (stage: "persist", message: string): void;
}

export async function backfillNamedContactEmails(
  target: EmailBackfillTarget,
  tracer: HarnessTracer,
  onProgress: ProgressSink,
): Promise<{ emailsFound: number; outcome: HuntTargetOutcome["outcome"] }> {
  const domain = websiteDomainOf(target.website);
  if (!domain) return { emailsFound: 0, outcome: "no_website" };
  if (!websiteMatchesCompany(`https://${domain}`, target.companyName)) return { emailsFound: 0, outcome: "domain_mismatch" };
  if (!(await domainHasMailInfrastructure(domain).catch(() => false))) return { emailsFound: 0, outcome: "no_mx" };
  const namedContactRows = await db
    .select({ id: contacts.id, name: contacts.name, email: contacts.email })
    .from(contacts)
    .where(and(eq(contacts.companyId, target.companyId), isNotNull(contacts.name), isNull(contacts.email)));

  let emailsFound = 0;
  if (namedContactRows.length > 0) {
    emailsFound += await backfillFromWebEvidence(target, tracer, onProgress, namedContactRows);
    emailsFound += await backfillFromPattern(target, onProgress, namedContactRows);
  }
  if (emailsFound > 0) return { emailsFound, outcome: "found" };

  emailsFound += await backfillRoleInbox(target, onProgress);
  return { emailsFound, outcome: emailsFound > 0 ? "found" : namedContactRows.length > 0 ? "exhausted_attempts" : "no_contacts" };
}

const DIRECTORY_HOSTS = [
  "indonetwork",
  "indotrading",
  "tokopedia",
  "shopee",
  "bukalapak",
  "lazada",
  "blibli",
  "olx",
  "facebook",
  "instagram",
  "linkedin",
  "twitter",
  "x.com",
  "youtube",
  "tiktok",
  "yellowpages",
  "perusahaan.id",
  "daftarperusahaan",
  "caribisnis",
  "infobis",
  "indeksonline",
  "blogspot",
  "wordpress",
  "wixsite",
  "weebly",
  "sites.google",
  "linktr.ee",
  "wa.me",
  "whatsapp",
  "google",
  "maps.app",
  "goo.gl",
  "bit.ly",
  "kaskus",
  "foursquare",
  "yelp",
  "tripadvisor",
  "waze",
  "mapquest",
  "tomtom",
  "here.com",
  "apple.com",
  "shopee.co.id",
  "amazon",
];

function isDirectoryHost(domain: string): boolean {
  return DIRECTORY_HOSTS.some((host) => domain === host || domain.includes(host));
}

export function websiteDomainOf(website: string | null | undefined): string | null {
  if (!website) return null;
  const domain = website
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
  return domain.includes(".") ? domain : null;
}

export async function backfillRoleInbox(target: EmailBackfillTarget, onProgress: ProgressSink): Promise<number> {
  const domain = websiteDomainOf(target.website);
  if (!domain || isDirectoryHost(domain)) return 0;
  if (!websiteMatchesCompany(`https://${domain}`, target.companyName)) return 0;

  const [suppressed] = await db.select({ id: suppressions.id }).from(suppressions).where(eq(suppressions.domain, domain)).limit(1);
  if (suppressed) return 0;

  const mailLive = await domainHasMailInfrastructure(domain).catch(() => false);
  if (!mailLive) return 0;

  const prefixes = await learnRolePrefixes().catch(() => [] as string[]);
  const candidates = prefixes.map((prefix) => `${prefix}@${domain}`);
  let inserted = 0;

  for (const email of candidates) {
    const rows = await db
      .insert(contacts)
      .values({
        dedupeKey: `${target.companyId}|contact|role-inbox|${email}`,
        companyId: target.companyId,
        name: null,
        title: "general/role inbox",
        email,
        emailType: "role",
        phone: null,
        phoneNormalized: null,
        waLikely: null,
        whatsapp: null,
        linkedinUrl: null,
        isDecisionMaker: null,
        raw: null,
        fieldProvenance: {
          email: {
            stage: "role-inferred",
            candidates,
            verification: "mx-only",
            verifiedBy: null,
            at: new Date().toISOString(),
          },
        },
      })
      .onConflictDoNothing({ target: contacts.dedupeKey })
      .returning({ id: contacts.id });
    inserted += rows.length;
  }

  if (inserted > 0) {
    await refreshCompanyEmailFlag(target.companyId);
  }
  if (inserted > 0) onProgress("persist", `${inserted} role inbox(es) for "${target.companyName}" on ${domain}`);
  return inserted;
}

async function backfillFromWebEvidence(target: EmailBackfillTarget, tracer: HarnessTracer, onProgress: ProgressSink, rows: NamedContactRow[]): Promise<number> {
  const websiteDomain = target.website
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
  let filled = 0;
  let evidenceBudget = 1;
  for (const row of rows) {
    if (evidenceBudget === 0) break;
    evidenceBudget -= 1;
    const personName = row.name ?? "";
    const evidence = await tracer.span(
      `email-evidence "${personName}"`,
      () => harvestPersonEmailEvidence(target.companyName, personName, websiteDomain).catch(() => []),
      (result) => ({ candidates: result.length, mentionsPerson: result.some((e) => e.mentionsPerson) }),
    );
    const best = evidence.find((e) => e.mentionsPerson) ?? evidence[0];
    if (!best) continue;
    const mailLive = await domainHasMailInfrastructure(best.domain).catch(() => false);
    if (!mailLive) continue;
    await db
      .update(contacts)
      .set({
        email: best.email,
        emailType: "personal",
        fieldProvenance: sql`${contacts.fieldProvenance} || ${JSON.stringify({ email: { stage: "web-evidence", sourceUrl: best.sourceUrl, mentionsPerson: best.mentionsPerson, at: new Date().toISOString() } })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(contacts.id, row.id));
    await refreshCompanyEmailFlag(target.companyId);
    filled += 1;
    onProgress(
      "persist",
      `web-evidence email for "${personName}" at "${target.companyName}" (${best.email}${best.mentionsPerson ? ", name-matched" : ", domain-only"})`,
    );
  }
  return filled;
}

async function backfillFromPattern(target: EmailBackfillTarget, onProgress: ProgressSink, rows: NamedContactRow[]): Promise<number> {
  const domain = target.website
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
  const observed = await db
    .select({ email: contacts.email })
    .from(contacts)
    .where(and(eq(contacts.companyId, target.companyId), isNotNull(contacts.email)))
    .limit(10);
  const pattern = inferEmailPattern(
    domain,
    observed.map((o) => o.email ?? ""),
  );
  if (!pattern) return 0;

  let filled = 0;
  let guessBudget = 2;
  for (const row of rows) {
    if (guessBudget === 0) break;
    if (row.email) continue;
    const guess = guessPersonalEmails(domain, row.name ?? "", pattern)[0];
    if (!guess) continue;
    guessBudget -= 1;
    const mailLive = await domainHasMailInfrastructure(domain).catch(() => false);
    if (!mailLive) break;
    const remote = await verifyEmailRemote(guess.email).catch(() => null);
    if (remote?.status === "invalid") continue;
    const verified = remote?.status === "valid";
    await db
      .update(contacts)
      .set({
        email: guess.email,
        emailType: "personal",
        fieldProvenance: sql`${contacts.fieldProvenance} || ${JSON.stringify({ email: { stage: "pattern-inferred", pattern: guess.pattern, confidence: guess.confidence, verifiedBy: verified ? remote?.provider : null, verificationStatus: remote?.status ?? "mx-only", at: new Date().toISOString() } })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(contacts.id, row.id));
    await refreshCompanyEmailFlag(target.companyId);
    filled += 1;
    onProgress(
      "persist",
      `pattern-inferred email for "${row.name}" at "${target.companyName}" (${guess.pattern}, ${verified ? `verified by ${remote?.provider}` : "mx-checked, unverified"})`,
    );
  }
  return filled;
}
