import { defineEventHandler, readBody } from "h3";
import { z } from "zod";
import { requireUser } from "@server/utils/auth";
import { renameUser } from "@src/lib/auth";

const bodySchema = z.object({ name: z.string().min(1).max(120) });

export default defineEventHandler(async (event) => {
  const user = await requireUser(event);
  const body = bodySchema.parse(await readBody(event));
  const updated = await renameUser(user.id, body.name.trim());
  return { user: updated };
});
