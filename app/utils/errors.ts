export function friendlyError(err: unknown): string {
  if (typeof err === "string") return friendlyText(err);
  if (err && typeof err === "object") {
    const anyErr = err as { data?: { statusMessage?: string; message?: string }; statusMessage?: string; message?: string };
    const raw = anyErr.data?.statusMessage ?? anyErr.data?.message ?? anyErr.statusMessage ?? anyErr.message;
    if (raw) return friendlyText(raw);
  }
  return "Something went wrong. Please try again.";
}

function friendlyText(raw: string): string {
  const map: Array<[RegExp, string]> = [
    [/Google OAuth is not configured/i, "Google Sheets isn't set up yet. Google OAuth credentials need to be added to the server config."],
    [/Incorrect email or password/i, "That email and password combination doesn't match. Try again or reset your password."],
    [/already installed/i, "A server with this name is already installed. Remove it first or pick a different name."],
    [/failed to connect/i, "Couldn't connect to that server. Check the address and credentials, then try again."],
    [/credential not found/i, "This connection no longer exists. Refresh the page and try again."],
    [/failed to decrypt/i, "Saved credentials are unreadable. They may have been re-encrypted. Please reconnect."],
    [/already exists/i, "Something with this name already exists. Pick a different name."],
    [/not found/i, "We couldn't find that. It may have been deleted."],
    [/unauthorized|unauthenticated/i, "Your session expired. Sign in again."],
    [/network|fetch failed|ECONNREFUSED/i, "Couldn't reach the server. Check your connection and try again."],
    [/rate.?limit|429/i, "Too many requests. Wait a moment and try again."],
    [/timeout|timed?\s?out/i, "That took too long. Try again."],
  ];
  for (const [pattern, friendly] of map) {
    if (pattern.test(raw)) return friendly;
  }
  const cleaned = raw
    .replace(/\[GET\]|\[POST\]|\[PATCH\]|\[DELETE\]|\[PUT\]/g, "")
    .replace(/"\//g, "")
    .trim();
  if (/^\d{3}/.test(cleaned) || cleaned.length > 120) return "Something went wrong. Please try again.";
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
