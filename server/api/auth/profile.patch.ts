import { defineEventHandler, readBody } from "h3";
import { z } from "zod";
import { requireUser } from "@server/utils/auth";
import { changeEmail, renameUser } from "@src/lib/auth";

const bodySchema = z.object({
  name: z.string().min(1).max(120).optional(),
  email: z.string().email().optional(),
});

export default defineEventHandler(async (event) => {
  const user = await requireUser(event);
  const body = bodySchema.parse(await readBody(event));

  let updated = user;
  if (body.name !== undefined) {
    updated = await renameUser(user.id, body.name.trim());
  }
  if (body.email !== undefined) {
    updated = await changeEmail(user.id, body.email);
  }
  return { user: updated };
});
