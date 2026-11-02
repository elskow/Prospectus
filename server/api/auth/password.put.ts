import { createError, defineEventHandler, readBody } from "h3";
import { z } from "zod";
import { requireUser } from "@server/utils/auth";
import { changePassword } from "@src/lib/auth";

const bodySchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(200),
});

export default defineEventHandler(async (event) => {
  const user = await requireUser(event);
  const body = bodySchema.parse(await readBody(event));
  const ok = await changePassword(user.id, body.currentPassword, body.newPassword);
  if (!ok) throw createError({ statusCode: 400, statusMessage: "current password is incorrect" });
  return { ok: true };
});
