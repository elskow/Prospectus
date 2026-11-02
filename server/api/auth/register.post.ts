import { createError, defineEventHandler, readBody, setCookie } from "h3";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { createSession, registerUser, sessionCookieOptions, SESSION_COOKIE } from "@src/lib/auth";
import { db } from "@src/db";
import { users } from "@src/db/schema";

const registerSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100),
  password: z.string().min(8).max(200),
});

export default defineEventHandler(async (event) => {
  const body = registerSchema.parse(await readBody(event));
  const email = body.email.toLowerCase();

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (existing) {
    throw createError({ statusCode: 409, statusMessage: "email already registered" });
  }

  const user = await registerUser(email, body.name, body.password);
  const session = await createSession(user.id);

  setCookie(event, SESSION_COOKIE, session.token, sessionCookieOptions(session.expiresAt));

  return { user };
});
