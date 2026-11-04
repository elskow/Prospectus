import { defineEventHandler } from "h3";
import { requireUser } from "@server/utils/auth";
import { listUsers } from "@src/lib/auth";

export default defineEventHandler(async (event) => {
  await requireUser(event);
  const users = await listUsers();
  return { users };
});
