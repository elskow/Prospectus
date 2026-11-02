import { defineEventHandler } from "h3";
import { requireUser } from "@server/utils/auth";
import { getModelSelection } from "@src/lib/model-settings";

export default defineEventHandler(async (event) => {
  await requireUser(event);
  return { selection: await getModelSelection() };
});
