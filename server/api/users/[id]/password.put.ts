import { defineEventHandler, getRouterParam, readBody } from "h3";
import { z } from "zod";
import { requireUser } from "@server/utils/auth";
import { resetUserPassword } from "@src/lib/auth";

const bodySchema = z.object({ newPassword: z.string().min(8).max(200) });

export default defineEventHandler(async (event) => {
  await requireUser(event);
  const id = getRouterParam(event, "id");
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: "missing id" });
  }
  const body = bodySchema.parse(await readBody(event));
  await resetUserPassword(id, body.newPassword);
  return { ok: true };
});
