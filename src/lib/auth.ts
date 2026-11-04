import { db } from "@src/db";
import { sessions, users } from "@src/db/schema";
import { and, eq, gt } from "drizzle-orm";
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { createError } from "h3";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PASSWORD_KEYLEN = 64;

export const SESSION_COOKIE = "prospectus_session";

function createConflictError(reason: string): Error {
  return createError({ statusCode: 409, statusMessage: reason, data: { reason } });
}

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

export async function changeEmail(userId: string, newEmail: string): Promise<SessionUser> {
  const email = newEmail.trim().toLowerCase();
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing && existing.id !== userId) {
    throw createConflictError("email_taken");
  }
  const [row] = await db.update(users).set({ email }).where(eq(users.id, userId)).returning();
  if (!row) throw new Error("user not found");
  return { id: row.id, email: row.email, name: row.name };
}

export async function createUser(email: string, name: string, password: string): Promise<SessionUser> {
  const normalized = email.trim().toLowerCase();
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, normalized)).limit(1);
  if (existing) {
    throw createConflictError("email_taken");
  }
  const passwordHash = await hashPassword(password);
  const [row] = await db.insert(users).values({ email: normalized, name, passwordHash }).returning();
  if (!row) throw new Error("user insert returned no rows");
  return { id: row.id, email: row.email, name: row.name };
}

export async function resetUserPassword(userId: string, newPassword: string): Promise<void> {
  const passwordHash = await hashPassword(newPassword);
  await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

export async function deleteUser(userId: string): Promise<void> {
  await db.delete(users).where(eq(users.id, userId));
}

export async function listUsers(): Promise<Array<{ id: string; email: string; name: string; createdAt: Date }>> {
  return db.select({ id: users.id, email: users.email, name: users.name, createdAt: users.createdAt }).from(users).orderBy(users.createdAt);
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
