import { createError, defineEventHandler, setCookie, getRequestURL } from "h3";
import { randomBytes } from "node:crypto";
import { requireUser } from "@server/utils/auth";

const STATE_COOKIE = "g-oauth-state";

export default defineEventHandler(async (event) => {
  const user = await requireUser(event);

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const appUrl = process.env.APP_URL ?? getRequestURL(event).origin;

  if (!clientId || !clientSecret) {
    throw createError({
      statusCode: 400,
      statusMessage: "Google OAuth is not configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET",
    });
  }

  const state = randomBytes(16).toString("hex");
  setCookie(event, STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
  });

  const redirectUri = `${appUrl}/api/auth/google/callback`;
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file",
    access_type: "offline",
    prompt: "consent",
    state,
  });

  return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` };
});
