import type { AdapterCatalogEntry, AdapterDefinition } from "@src/adapters/types";

export interface PluginManifest {
  name: string;
  description: string;
  schemaVersion: number;
}

export interface AdapterPlugin<TDefinition extends AdapterDefinition = AdapterDefinition> {
  manifest: PluginManifest;
  definition: TDefinition;
  catalog: Omit<AdapterCatalogEntry, "kind"> & { kind: TDefinition["kind"] };
}

export function definePlugin<const T extends AdapterDefinition>(plugin: AdapterPlugin<T>): AdapterPlugin<T> {
  return plugin;
}
