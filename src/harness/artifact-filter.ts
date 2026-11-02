import { db } from "@src/db";
import { companies } from "@src/db/schema";
import type { LeadCandidate } from "@src/harness/schemas";
import type { RawCompanyArtifact } from "@src/adapters/types";

export interface KnownArtifactIndex {
  domains: Set<string>;
  phones: Set<string>;
  names: Set<string>;
}

function nameKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  return key.length >= 4 ? key : null;
}

function domainKey(website: string | null | undefined): string | null {
  if (!website) return null;
  try {
    const host = new URL(website.startsWith("http") ? website : `https://${website}`).hostname.toLowerCase().replace(/^www\./, "");
    return host.includes(".") ? host : null;
  } catch {
    return null;
  }
}

function phoneKeys(phone: string | null | undefined): string[] {
  if (!phone) return [];
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length < 8) return [];
  const keys = new Set<string>([digits]);
  const local = digits.replace(/^62/, "0");
  keys.add(local);
  if (digits.length > 9) keys.add(digits.slice(-9));
  if (local.length > 9) keys.add(local.slice(-9));
  return [...keys];
}

export async function loadKnownArtifactIndex(): Promise<KnownArtifactIndex> {
  const rows = await db.select({ website: companies.website, phone: companies.phone, name: companies.name }).from(companies);
  const index: KnownArtifactIndex = { domains: new Set(), phones: new Set(), names: new Set() };
  for (const row of rows) {
    const domain = domainKey(row.website);
    if (domain) index.domains.add(domain);
    for (const phone of phoneKeys(row.phone)) index.phones.add(phone);
    const name = nameKey(row.name);
    if (name) index.names.add(name);
  }
  return index;
}

function artifactMatches(
  index: KnownArtifactIndex,
  name: string | null | undefined,
  website: string | null | undefined,
  phone: string | null | undefined,
): boolean {
  const domain = domainKey(website);
  if (domain && index.domains.has(domain)) return true;
  for (const key of phoneKeys(phone)) {
    if (index.phones.has(key)) return true;
  }
  const normalizedName = nameKey(name);
  return Boolean(normalizedName && index.names.has(normalizedName));
}

export function artifactIsKnown(index: KnownArtifactIndex, artifact: RawCompanyArtifact): boolean {
  return artifactMatches(index, artifact.name, artifact.website, artifact.phone);
}

export function candidateIsKnown(index: KnownArtifactIndex, candidate: LeadCandidate): boolean {
  return artifactMatches(index, candidate.name, candidate.website, candidate.phone);
}

export function indexCandidate(index: KnownArtifactIndex, candidate: LeadCandidate): void {
  const domain = domainKey(candidate.website);
  if (domain) index.domains.add(domain);
  for (const phone of phoneKeys(candidate.phone)) index.phones.add(phone);
  const name = nameKey(candidate.name);
  if (name) index.names.add(name);
}
