export function normalizePhone(raw: string): string | null {
  const digits = raw.replace(/[^0-9+]/g, "");
  let national = digits.replace(/^\+?62/, "0").replace(/\D/g, "");
  if (national.startsWith("62")) national = `0${national.slice(2)}`;
  if (!national.startsWith("0") || national.length < 9 || national.length > 14) return null;
  return `+62${national.slice(1)}`;
}

const GENERIC_NAME_PATTERN =
  /^(perusahaan|pt|cv|ud|kantor|toko|usaha|bisnis|company|business|pabrik|distributor|supplier|vendor|agent|agen)(\s+(manufaktur|manufacturing|industri|industry|umum|general|jasa|services|logistik|logistics|konsultan|consulting|teknik|engineering|dagang|trading|spbu|grosir|wholesale|eceran|retail))?$/i;

export function isGenericCompanyName(name: string): boolean {
  const normalized = name.trim().replace(/\s+/g, " ");
  if (normalized.length < 3) return true;
  return GENERIC_NAME_PATTERN.test(normalized);
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WEBSITE_PATTERN = /^https?:\/\//i;

export interface ValidationNote {
  rule: string;
  message: string;
  at?: string;
}

export function stampNotes(notes: ValidationNote[]): Array<{ rule: string; message: string; at: string }> {
  const at = new Date().toISOString();
  return notes.map((n) => ({ rule: n.rule, message: n.message, at }));
}

export interface ValidationVerdict {
  level: "accept" | "review" | "reject";
  notes: ValidationNote[];
}

export function validateCandidate(candidate: {
  name: string;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  country?: string | null;
}): ValidationVerdict {
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  if (!name || isGenericCompanyName(candidate.name)) {
    return {
      level: "reject",
      notes: [{ rule: "name", message: name ? "generic or non-specific company name" : "company name missing or blank" }],
    };
  }

  const notes: ValidationNote[] = [];
  if (candidate.email && !EMAIL_PATTERN.test(candidate.email.trim())) {
    notes.push({ rule: "email", message: "email does not match basic email shape" });
  }
  if (candidate.phone) {
    const international = typeof candidate.country === "string" && candidate.country.trim().length > 0 && candidate.country !== "Indonesia";
    const hasDigits = /[0-9]/.test(candidate.phone);
    if (!hasDigits || (!international && normalizePhone(candidate.phone) === null)) {
      notes.push({ rule: "phone", message: "phone not normalizable to an Indonesian national number" });
    }
  }
  const website = candidate.website?.trim();
  if (website && !WEBSITE_PATTERN.test(website)) {
    notes.push({ rule: "website", message: "website missing http(s) scheme" });
  }
  if (notes.length > 0) return { level: "review", notes };
  return { level: "accept", notes };
}
