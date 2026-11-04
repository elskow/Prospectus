import { patchrightStealthFetch } from "@src/harness/stealth-fetch";

const CHALLENGE_RE =
  /jschl_vc|cdn-cgi\/challenge|cf_chl_[a-z_]*|challenges\.cloudflare\.com\/turnstile|(?:just a moment|tunggu sebentar|please wait)[\s\S]{0,80}cloudflare/i;
const STEALTH_TIMEOUT_MS = 45_000;

export function looksLikeChallenge(html: string | null): boolean {
  if (!html) return false;
  return CHALLENGE_RE.test(html);
}

export async function fetchHtmlWithChallengeFallback(url: string, cheapFetch: (target: string) => Promise<string | null>): Promise<string | null> {
  const html = await cheapFetch(url);
  if (html !== null && !looksLikeChallenge(html)) {
    return html;
  }
  const page = await patchrightStealthFetch(url, { timeoutMs: STEALTH_TIMEOUT_MS });
  if (page.html !== null && page.status === 200 && !looksLikeChallenge(page.html)) {
    return page.html;
  }
  return html;
}
