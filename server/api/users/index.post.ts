import { defineEventHandler, readBody } from "h3";
import { z } from "zod";
import { requireUser } from "@server/utils/auth";
import { createUser } from "@src/lib/auth";

const bodySchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(120),
  password: z.string().min(8).max(200),
});

export default defineEventHandler(async (event) => {
  await requireUser(event);
  const body = bodySchema.parse(await readBody(event));
  const user = await createUser(body.email, body.name.trim(), body.password);
  return { user };
});
