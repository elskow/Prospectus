import { defineEventHandler, getRouterParam } from "h3";
import { createError } from "h3";
import { requireUser } from "@server/utils/auth";
import { deleteUser } from "@src/lib/auth";

export default defineEventHandler(async (event) => {
  const caller = await requireUser(event);
  const id = getRouterParam(event, "id");
  if (!id) {
    throw createError({ statusCode: 400, statusMessage: "missing id" });
  }
  if (id === caller.id) {
    throw createError({ statusCode: 400, statusMessage: "cannot delete your own account" });
  }
  await deleteUser(id);
  return { ok: true };
});
