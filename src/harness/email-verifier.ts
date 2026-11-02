import { loadSearchSettings } from "@src/harness/websearch";

export type EmailVerificationStatus = "valid" | "invalid" | "catch-all" | "unknown" | "role";

export interface EmailVerification {
  email: string;
  status: EmailVerificationStatus;
  provider: string;
  smtpProvider: boolean | null;
  freeProvider: boolean | null;
  didYouMean: string | null;
}

interface ZeroBounceResponse {
  status: string;
  sub_status?: string;
  did_you_mean?: string;
  free_email?: boolean;
  smtp_provider?: string | boolean;
}

interface NeverBounceResponse {
  status: string;
  result?: string;
  suspect?: boolean;
}

const CACHE = new Map<string, { at: number; value: EmailVerification }>();
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_MAX = 2000;

export function emailVerifierConfigured(): boolean {
  return Boolean(settingsSnapshot?.emailVerifierApiKey);
}

let settingsSnapshot: { emailVerifierApiKey: string | null; emailVerifierProvider: "zerobounce" | "neverbounce" } | null = null;

export async function refreshVerifierSettings(): Promise<void> {
  const settings = await loadSearchSettings();
  settingsSnapshot = { emailVerifierApiKey: settings.emailVerifierApiKey, emailVerifierProvider: settings.emailVerifierProvider };
}

export async function verifyEmailRemote(email: string, timeoutMs = 12_000): Promise<EmailVerification | null> {
  const config = settingsSnapshot;
  if (!config?.emailVerifierApiKey) return null;

  const cacheKey = `${config.emailVerifierProvider}:${email.toLowerCase()}`;
  const cached = CACHE.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const result =
    config.emailVerifierProvider === "neverbounce"
      ? await verifyNeverBounce(email, config.emailVerifierApiKey, timeoutMs)
      : await verifyZeroBounce(email, config.emailVerifierApiKey, timeoutMs);

  if (result) {
    if (CACHE.size >= CACHE_MAX) {
      const oldest = [...CACHE.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 500);
      for (const [key] of oldest) CACHE.delete(key);
    }
    CACHE.set(cacheKey, { at: Date.now(), value: result });
  }
  return result;
}

async function verifyZeroBounce(email: string, apiKey: string, timeoutMs: number): Promise<EmailVerification | null> {
  try {
    const url = `https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(apiKey)}&email=${encodeURIComponent(email)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const data = (await res.json()) as ZeroBounceResponse;
    const status = (data.status ?? "unknown").toLowerCase();
    const mapped: EmailVerificationStatus =
      status === "valid" ? "valid" : status === "invalid" ? "invalid" : status === "catch-all" || data.sub_status === "catch-all" ? "catch-all" : "unknown";
    return {
      email,
      status: mapped,
      provider: "zerobounce",
      smtpProvider: typeof data.smtp_provider === "boolean" ? data.smtp_provider : data.smtp_provider ? true : null,
      freeProvider: data.free_email ?? null,
      didYouMean: data.did_you_mean ?? null,
    };
  } catch {
    return null;
  }
}

async function verifyNeverBounce(email: string, apiKey: string, timeoutMs: number): Promise<EmailVerification | null> {
  try {
    const res = await fetch("https://api.neverbounce.com/v4/apps/validate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ key: apiKey, email }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as NeverBounceResponse;
    const result = (data.result ?? "unknown").toLowerCase();
    const mapped: EmailVerificationStatus =
      result === "valid" ? "valid" : result === "invalid" ? "invalid" : result === "catchall" || data.suspect ? "catch-all" : "unknown";
    return { email, status: mapped, provider: "neverbounce", smtpProvider: null, freeProvider: null, didYouMean: null };
  } catch {
    return null;
  }
}
