import { createError, defineEventHandler, getRequestIP, readBody, setCookie } from "h3";
import { z } from "zod";
import { createSession, sessionCookieOptions, SESSION_COOKIE, verifyLogin } from "@src/lib/auth";

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60_000;
const attempts = new Map<string, { count: number; resetAt: number }>();

function attemptKey(ip: string, email: string): string {
  return `${ip}|${email.toLowerCase()}`;
}

export default defineEventHandler(async (event) => {
  const body = loginSchema.parse(await readBody(event));
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? "unknown";
  const key = attemptKey(ip, body.email);

  const entry = attempts.get(key);
  if (entry && Date.now() > entry.resetAt) attempts.delete(key);
  const current = attempts.get(key);
  if (current && current.count >= MAX_ATTEMPTS) {
    const retrySeconds = Math.max(1, Math.ceil((current.resetAt - Date.now()) / 1000));
    throw createError({
      statusCode: 429,
      statusMessage: "too many login attempts; try again later",
      data: { retryAfterSeconds: retrySeconds },
    });
  }

  const user = await verifyLogin(body.email, body.password);
  if (!user) {
    const next = current ?? { count: 0, resetAt: Date.now() + WINDOW_MS };
    next.count += 1;
    attempts.set(key, next);
    if (attempts.size > 5_000) {
      for (const [candidate, value] of attempts) {
        if (Date.now() > value.resetAt) attempts.delete(candidate);
      }
    }
    throw createError({ statusCode: 401, statusMessage: "invalid credentials" });
  }

  attempts.delete(key);
  const session = await createSession(user.id);
  setCookie(event, SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));

  return { user };
});
