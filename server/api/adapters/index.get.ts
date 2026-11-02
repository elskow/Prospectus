import { defineEventHandler } from "h3";
import { ADAPTER_CATALOG } from "@src/adapters/catalog";
import { prospectusConfig } from "../../../prospectus.config";

export default defineEventHandler(async () => {
  return {
    adapters: ADAPTER_CATALOG.map((entry) => ({
      ...entry,
      enabled: prospectusConfig.adapters.some((a) => a.type === entry.type && a.enabled),
    })),
  };
});
