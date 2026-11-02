import { db } from "@src/db";
import { sessions, users } from "@src/db/schema";
import { and, eq, gt } from "drizzle-orm";
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PASSWORD_KEYLEN = 64;

export const SESSION_COOKIE = "prospectus_session";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

function randomToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

function expiry(): Date {
  return new Date(Date.now() + SESSION_TTL_MS);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, PASSWORD_KEYLEN);
  return `scrypt:${salt.toString("hex")}:${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, hashHex] = stored.split(":");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;

  const derived = await scrypt(password, Buffer.from(saltHex, "hex"), PASSWORD_KEYLEN);
  const expected = Buffer.from(hashHex, "hex");

  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export async function registerUser(email: string, name: string, password: string): Promise<SessionUser> {
  const passwordHash = await hashPassword(password);
  const rows = await db.insert(users).values({ email: email.toLowerCase(), name, passwordHash }).returning();

  const row = rows[0];

  if (!row) throw new Error("user insert returned no rows");

  return {
    id: row.id,
    email: row.email,
    name: row.name,
  };
}

export async function verifyLogin(email: string, password: string): Promise<SessionUser | null> {
  const [row] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));

  if (!row) return null;

  const valid = await verifyPassword(password, row.passwordHash);
  if (!valid) return null;

  return {
    id: row.id,
    email: row.email,
    name: row.name,
  };
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken();
  const expiresAt = expiry();

  await db.insert(sessions).values({
    id: token,
    userId,
    expiresAt,
  });

  return {
    token,
    expiresAt,
  };
}

export async function renameUser(userId: string, name: string): Promise<SessionUser> {
  const [row] = await db.update(users).set({ name }).where(eq(users.id, userId)).returning();
  if (!row) throw new Error("user not found");
  return { id: row.id, email: row.email, name: row.name };
}

export async function changePassword(userId: string, currentPassword: string, newPassword: string): Promise<boolean> {
  const [row] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!row) return false;
  if (!(await verifyPassword(currentPassword, row.passwordHash))) return false;
  const passwordHash = await hashPassword(newPassword);
  await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
  return true;
}

export async function getSessionUser(token: string | null | undefined): Promise<SessionUser | null> {
  if (!token) return null;

  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.id, token), gt(sessions.expiresAt, new Date())));

  return row ?? null;
}

export async function destroySession(token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, token));
}

export const sessionCookieOptions = (expiresAt: Date) => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: (process.env.APP_URL ?? "").startsWith("https://"),
  path: "/",
  expires: expiresAt,
});

export function readSessionToken(cookieValue: string | null | undefined): string | null {
  return cookieValue ?? null;
}
