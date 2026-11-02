import { promises as dns } from "node:dns";

export interface OsintDomainReport {
  domain: string;
  rdap: {
    registrar: string | null;
    createdAt: string | null;
    updatedAt: string | null;
    expiresAt: string | null;
    ageYears: number | null;
    status: string[];
    nameservers: string[];
  } | null;
  subdomains: string[];
  dns: {
    a: string[];
    mx: string[];
    txt: string[];
    nameservers: string[];
    hasSpf: boolean;
    hasDmarc: boolean;
    mailProvider: string | null;
  };
  notes: string[];
}

const RDAP_BOOTSTRAP = "https://rdap.org/domain/";

interface RdapResponse {
  events?: { eventAction: string; eventDate: string }[];
  entities?: { roles?: string[]; vcardArray?: unknown[]; publicIds?: unknown }[];
  status?: string[];
  nameservers?: { ldhName?: string }[];
}

function registrarFromRdap(rdap: RdapResponse): string | null {
  const entity = rdap.entities?.find((e) => e.roles?.includes("registrar"));
  const vcard = entity?.vcardArray?.[1];
  if (!Array.isArray(vcard)) return null;
  const fn = vcard.find((entry) => Array.isArray(entry) && entry[0] === "fn");
  return typeof fn?.[3] === "string" ? fn[3] : null;
}

function eventDate(rdap: RdapResponse, action: string): string | null {
  return rdap.events?.find((e) => e.eventAction === action)?.eventDate ?? null;
}

const MAIL_PROVIDERS: [RegExp, string][] = [
  [/google($|\.)|googlemail/i, "Google Workspace"],
  [/outlook\.com|microsoft\.com|office365/i, "Microsoft 365"],
  [/zoho/i, "Zoho"],
  [/yandex/i, "Yandex"],
  [/mailgun/i, "Mailgun"],
  [/sendgrid/i, "SendGrid"],
  [/amazonaws|amazonses/i, "AWS SES"],
  [/proton/i, "Proton"],
];

export async function osintDomainLookup(domainRaw: string, opts?: { subdomainLimit?: number; timeoutMs?: number }): Promise<OsintDomainReport> {
  const domain = domainRaw
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
  const notes: string[] = [];

  const [rdapResult, crtResult, aResult, mxResult, txtResult, nsResult] = await Promise.allSettled([
    fetchRdap(domain, opts?.timeoutMs ?? 12_000),
    fetchSubdomains(domain, opts?.subdomainLimit ?? 40),
    dns.resolve4(domain),
    dns.resolveMx(domain),
    dns.resolveTxt(domain),
    dns.resolveNs(domain),
  ]);

  const rdap = rdapResult.status === "fulfilled" ? rdapResult.value : null;
  if (rdapResult.status === "rejected") notes.push(`rdap unavailable: ${rdapResult.reason?.message ?? "unknown"}`);

  const [dmarcOk] = await Promise.all([hasDmarc(domain)]);
  const subdomains = crtResult.status === "fulfilled" ? crtResult.value : [];

  const createdAt = rdap ? eventDate(rdap, "registration") : null;
  const ageYears = createdAt ? Math.floor((Date.now() - new Date(createdAt).getTime()) / (365.25 * 24 * 3600 * 1000)) : null;

  const a = aResult.status === "fulfilled" ? aResult.value : [];
  const mx = mxResult.status === "fulfilled" ? mxResult.value.map((r) => r.exchange) : [];
  const txt = txtResult.status === "fulfilled" ? txtResult.value.flat() : [];
  const nameservers = nsResult.status === "fulfilled" ? nsResult.value : [];

  const mailProvider = mx.map((exchange) => MAIL_PROVIDERS.find(([re]) => re.test(exchange))?.[1]).find((v) => v !== undefined) ?? null;

  return {
    domain,
    rdap: rdap
      ? {
          registrar: registrarFromRdap(rdap),
          createdAt,
          updatedAt: eventDate(rdap, "last changed"),
          expiresAt: eventDate(rdap, "expiration"),
          ageYears,
          status: rdap.status ?? [],
          nameservers: (rdap.nameservers ?? []).map((n) => n.ldhName ?? "").filter(Boolean),
        }
      : null,
    subdomains,
    dns: {
      a,
      mx,
      txt,
      nameservers,
      hasSpf: txt.some((t) => t.startsWith("v=spf1")),
      hasDmarc: dmarcOk,
      mailProvider,
    },
    notes,
  };
}

async function fetchRdap(domain: string, timeoutMs: number): Promise<RdapResponse> {
  const res = await fetch(`${RDAP_BOOTSTRAP}${domain}`, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/rdap+json" } });
  if (!res.ok) throw new Error(`rdap http ${res.status}`);
  return (await res.json()) as RdapResponse;
}

async function fetchSubdomains(domain: string, limit: number): Promise<string[]> {
  const res = await fetch(`https://crt.sh/?q=${encodeURIComponent(`%.${domain}`)}&output=json`, {
    signal: AbortSignal.timeout(20_000),
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`crt.sh http ${res.status}`);
  const entries = (await res.json()) as { name_value?: string }[];
  const found = new Set<string>();
  for (const entry of entries) {
    for (const name of (entry.name_value ?? "").split("\n")) {
      const normalized = name.trim().toLowerCase().replace(/^\*\./, "");
      if (normalized.endsWith(`.${domain}`) && normalized !== domain) found.add(normalized);
    }
    if (found.size >= limit) break;
  }
  return [...found].sort();
}

export async function hasDmarc(domain: string): Promise<boolean> {
  try {
    const txt = await dns.resolveTxt(`_dmarc.${domain}`);
    return txt.flat().some((t) => t.startsWith("v=DMARC1"));
  } catch {
    return false;
  }
}
