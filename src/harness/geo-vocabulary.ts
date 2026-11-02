import { sql } from "drizzle-orm";
import { db } from "@src/db";

const REGISTRY_BASE = "https://wilayah.id/api";
const REGISTRY_TTL_MS = 24 * 60 * 60_000;

const JUNK = new Set([
  "indonesia",
  "jl",
  "jalan",
  "no",
  "blok",
  "kec",
  "kecamatan",
  "kel",
  "kelurahan",
  "adm",
  "administrasi",
  "daerah",
  "khusus",
  "ibukota",
  "rt",
  "rw",
  "wisata",
  "kawasan",
  "gedung",
  "lantai",
  "ruko",
  "komplek",
  "kompleks",
]);

let registryCache: { at: number; provinces: { code: string; name: string }[] } | null = null;
const regencyCache = new Map<string, { at: number; regencies: { code: string; name: string }[] }>();

function cleanCity(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let value = raw
    .replace(/\b(?:kota|kabupaten|kab\.?|kodya|administrasi)\b/gi, " ")
    .replace(/\b\d{3,6}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (value.length < 3 || value.length > 40) return null;
  if (!/^[A-Za-z]/.test(value)) return null;
  const first = value.split(" ")[0]?.toLowerCase() ?? "";
  if (JUNK.has(first)) return null;
  if (JUNK.has(value.toLowerCase())) return null;
  value = value.toLowerCase().replace(/\b\w/g, (char) => char.toUpperCase());
  return value;
}

async function registryProvinces(): Promise<{ code: string; name: string }[]> {
  if (registryCache && Date.now() - registryCache.at < REGISTRY_TTL_MS) return registryCache.provinces;
  const response = await fetch(`${REGISTRY_BASE}/provinces.json`, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`region registry HTTP ${response.status}`);
  const payload = (await response.json()) as { data: { code: string; name: string }[] };
  registryCache = { at: Date.now(), provinces: payload.data };
  return payload.data;
}

async function registryRegencies(provinceCode: string): Promise<{ code: string; name: string }[]> {
  const cached = regencyCache.get(provinceCode);
  if (cached && Date.now() - cached.at < REGISTRY_TTL_MS) return cached.regencies;
  const response = await fetch(`${REGISTRY_BASE}/regencies/${provinceCode}.json`, { signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`region registry HTTP ${response.status}`);
  const payload = (await response.json()) as { data: { code: string; name: string }[] };
  regencyCache.set(provinceCode, { at: Date.now(), regencies: payload.data });
  return payload.data;
}

export async function observedCities(): Promise<string[]> {
  const rows = (await db.execute<{ city: string | null }>(sql`
    select distinct coalesce(
      nullif(trim(city), ''),
      (regexp_match(address, '(?:Kota|Kabupaten|Kab\\.?)[ ]+([A-Za-z ]{3,40})'))[1]
    ) as city
    from companies
    where city is not null or address is not null
    union
    select area as city from campaigns where area is not null
  `)) as unknown as { city: string | null }[];

  const seen = new Set<string>();
  const cities: string[] = [];
  for (const row of rows) {
    const city = cleanCity(row.city);
    if (!city) continue;
    const key = city.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cities.push(city);
  }
  return cities;
}

export async function neighbouringCities(city: string): Promise<string[]> {
  try {
    const target = city.toLowerCase();
    const provinces = await registryProvinces();
    for (const province of provinces) {
      const regencies = await registryRegencies(province.code);
      const match = regencies.find((regency) => regency.name.toLowerCase().includes(target));
      if (!match) continue;
      return regencies.map((regency) => cleanCity(regency.name)).filter((name): name is string => name !== null && name.toLowerCase() !== target);
    }
    return [];
  } catch {
    return [];
  }
}
