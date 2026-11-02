export interface ExhibitorContact {
  name: string;
  email: string | null;
  phone: string | null;
  website: string | null;
  address: string | null;
  sourceUrl: string;
}

const DIRECTORIES = [
  "allpack-indonesia.com",
  "kristainterfood.com",
  "allprint.co.id",
  "indogartextexpo.com",
  "indoleatherfootwear.com",
  "cooltechexpo.com",
  "seafoodshowasia.com",
];

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36";

const STOPWORDS: Record<string, true> = {
  pt: true,
  cv: true,
  ud: true,
  tbk: true,
  persero: true,
  indonesia: true,
  group: true,
  the: true,
  and: true,
  co: true,
  ltd: true,
  inc: true,
};

const GENERIC_TOKENS: Record<string, true> = {
  industries: true,
  industry: true,
  manufacturing: true,
  manufaktur: true,
  industrial: true,
  internasional: true,
  international: true,
  global: true,
  nasional: true,
  nusantara: true,
  jaya: true,
  makmur: true,
  abadi: true,
  perkasa: true,
  utama: true,
  mandiri: true,
  sejahtera: true,
  sentosa: true,
  indah: true,
  sinar: true,
  sumber: true,
  karya: true,
  teknik: true,
  tehnik: true,
  perdana: true,
  abdi: true,
  cipta: true,
  tunggal: true,
  putra: true,
  putri: true,
  mitra: true,
  sarana: true,
  prima: true,
  mulia: true,
  agung: true,
  besar: true,
  sukses: true,
  maju: true,
  baru: true,
  group: true,
  holding: true,
  trading: true,
  dagang: true,
  plastik: true,
  plastic: true,
  kertas: true,
  paper: true,
  logam: true,
  metal: true,
  kimia: true,
  chemical: true,
  tekstil: true,
  textile: true,
  garmen: true,
  makanan: true,
  minuman: true,
  food: true,
  beverage: true,
  kemasan: true,
  packaging: true,
  kayu: true,
  wood: true,
  baja: true,
  steel: true,
  elektronik: true,
  electronic: true,
  otomotif: true,
  automotive: true,
  farmasi: true,
  pharma: true,
  kosmetik: true,
  cosmetic: true,
  karet: true,
  rubber: true,
  kaca: true,
  glass: true,
  semen: true,
  cement: true,
  pupuk: true,
  fertilizer: true,
  kabel: true,
  cable: true,
  pipa: true,
  pipe: true,
  percetakan: true,
  printing: true,
  mesin: true,
  machinery: true,
  komponen: true,
  component: true,
  suku: true,
};

function decodeEntities(input: string): string {
  return input
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function searchTermFor(companyName: string): string {
  const tokens = companyName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !STOPWORDS[t]);
  const distinctive = tokens.filter((t) => !GENERIC_TOKENS[t]).sort((a, b) => b.length - a.length);
  return distinctive[0] ?? tokens.sort((a, b) => b.length - a.length)[0] ?? companyName.replace(/[^a-zA-Z0-9\s]/g, " ").trim();
}

function signatureOf(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 4 && !STOPWORDS[t]);
}

export function exhibitorNameMatches(exhibitorName: string, companyName: string): boolean {
  const wanted = signatureOf(companyName).filter((t) => !GENERIC_TOKENS[t]);
  if (wanted.length === 0) return false;
  const candidate = new Set(signatureOf(exhibitorName).filter((t) => !GENERIC_TOKENS[t]));
  const shared = wanted.filter((token) => candidate.has(token));
  if (shared.length >= 2) return true;
  const only = shared[0] ?? "";
  return wanted.length === 1 && only.length >= 6;
}

function fieldOf(html: string, key: string): string | null {
  const match = html.match(new RegExp(`"${key}"\\s*:\\s*"?([^",}]+)`));
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : null;
}

async function lookupInDirectory(domain: string, companyName: string): Promise<ExhibitorContact | null> {
  const term = searchTermFor(companyName);
  if (!term) return null;

  const listRes = await fetch(`https://${domain}/api/ajax?type=search&page=1&search=${encodeURIComponent(term)}`, {
    headers: { "user-agent": UA, "x-requested-with": "XMLHttpRequest" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!listRes.ok) return null;

  const payload = (await listRes.json()) as { html?: string };
  const ids = [...new Set((payload.html ?? "").match(/detail-exhibitor\/(\d+)/g)?.map((m) => m.replace(/\D/g, "")) ?? [])].slice(0, 3);
  if (ids.length === 0) return null;

  for (const id of ids) {
    const detailRes = await fetch(`https://${domain}/detail-exhibitor/${id}`, {
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(12_000),
    });
    if (!detailRes.ok) continue;
    const html = decodeEntities(await detailRes.text());
    const name = fieldOf(html, "exhibitor_name");
    if (!name || !exhibitorNameMatches(name, companyName)) continue;
    const email = fieldOf(html, "email");
    const website = fieldOf(html, "website");
    return {
      name,
      email: email ? email.toLowerCase().replace(/\/$/, "") : null,
      phone: fieldOf(html, "official_phone"),
      website: website ? (website.startsWith("http") ? website : `https://${website.replace(/^\/+/, "")}`) : null,
      address: fieldOf(html, "address")?.replace(/\\\//g, "/") ?? null,
      sourceUrl: `https://${domain}/detail-exhibitor/${id}`,
    };
  }

  return null;
}

export async function lookupExhibitorContact(companyName: string, directories: string[] = DIRECTORIES): Promise<ExhibitorContact | null> {
  for (const domain of directories.slice(0, 4)) {
    const hit = await lookupInDirectory(domain, companyName).catch(() => null);
    if (hit && hit.email) return hit;
  }
  return null;
}
