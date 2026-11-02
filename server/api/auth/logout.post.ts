import { deleteCookie, defineEventHandler, getCookie } from "h3";
import { destroySession, SESSION_COOKIE } from "@src/lib/auth";

export default defineEventHandler(async (event) => {
  const token = getCookie(event, SESSION_COOKIE);
  if (token) {
    await destroySession(token);
  }
  deleteCookie(event, SESSION_COOKIE, { path: "/" });
  return { ok: true };
});
