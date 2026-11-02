import type { H3Event } from "h3";
import { createError, getCookie } from "h3";
import { SESSION_COOKIE, getSessionUser, readSessionToken, type SessionUser } from "@src/lib/auth";

export async function requireUser(event: H3Event): Promise<SessionUser> {
  const token = readSessionToken(getCookie(event, SESSION_COOKIE));

  const user = await getSessionUser(token);
  if (!user) {
    throw createError({ statusCode: 401, statusMessage: "unauthorized" });
  }

  return user;
}
