import { builtinPlugins } from "@src/plugins/builtin";
import type { AdapterCatalogEntry } from "@src/adapters/types";

export const ADAPTER_CATALOG: AdapterCatalogEntry[] = builtinPlugins().map((plugin) => plugin.catalog);

export function catalogEntry(type: string): AdapterCatalogEntry | undefined {
  return ADAPTER_CATALOG.find((entry) => entry.type === type);
}
