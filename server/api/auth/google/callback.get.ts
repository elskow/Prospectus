import { createError, defineEventHandler, getCookie, getRequestURL, setCookie } from "h3";
import { and, eq } from "drizzle-orm";
import { requireUser } from "@server/utils/auth";
import { db } from "@src/db";
import { credentials } from "@src/db/schema";
import { seal } from "@src/lib/crypto";

const STATE_COOKIE = "g-oauth-state";

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  error?: string;
}

export default defineEventHandler(async (event) => {
  await requireUser(event);
  const query = getQuery(event);
  const appUrl = process.env.APP_URL ?? getRequestURL(event).origin;

  const fail = (message: string): never => {
    setCookie(event, STATE_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
    throw createError({ statusCode: 400, statusMessage: message });
  };

  if (typeof query.error === "string" && query.error.length > 0) {
    fail(`google oauth error: ${query.error}`);
  }

  const code = typeof query.code === "string" ? query.code : null;
  const state = typeof query.state === "string" ? query.state : null;
  const cookieState = getCookie(event, STATE_COOKIE);

  if (!code) fail("missing oauth code");
  if (!state || !cookieState || state !== cookieState) fail("oauth state mismatch");

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) fail("Google OAuth is not configured on the server");

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: code as string,
      client_id: clientId as string,
      client_secret: clientSecret as string,
      redirect_uri: `${appUrl}/api/auth/google/callback`,
      grant_type: "authorization_code",
    }),
  });

  const tokenJson = (await tokenRes.json()) as GoogleTokenResponse;
  if (!tokenRes.ok || !tokenJson.refresh_token) {
    fail(`token exchange failed: ${tokenJson.error ?? `HTTP ${tokenRes.status}`}`);
  }

  const payload = await seal({
    clientId,
    clientSecret,
    refreshToken: tokenJson.refresh_token,
  });

  const existing = await db
    .select({ id: credentials.id })
    .from(credentials)
    .where(and(eq(credentials.adapterType, "sink:google-sheets"), eq(credentials.label, "google-oauth")));

  if (existing[0]) {
    await db.update(credentials).set({ payload, updatedAt: new Date(), lastVerifiedAt: new Date() }).where(eq(credentials.id, existing[0].id));
  } else {
    await db.insert(credentials).values({
      adapterType: "sink:google-sheets",
      label: "google-oauth",
      payload,
    });
  }

  setCookie(event, STATE_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return sendRedirect(event, "/settings?google=connected");
});
