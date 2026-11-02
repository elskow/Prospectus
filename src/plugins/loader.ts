import { builtinPlugins } from "@src/plugins/builtin";
import type { AdapterPlugin } from "@src/plugins/define";

export interface LoadedPlugins {
  plugins: AdapterPlugin[];
  warnings: string[];
}

export function loadPlugins(enabledTypes: { type: string; enabled: boolean }[]): LoadedPlugins {
  const plugins = builtinPlugins();
  const warnings: string[] = [];

  const seen = new Map<string, string>();
  for (const plugin of plugins) {
    const existing = seen.get(plugin.definition.type);
    if (existing) {
      warnings.push(`duplicate adapter type "${plugin.definition.type}" from plugins "${existing}" and "${plugin.manifest.name}"`);
      continue;
    }

    seen.set(plugin.definition.type, plugin.manifest.name);
  }

  const declared = new Set(enabledTypes.map((entry) => entry.type));
  for (const type of declared) {
    if (!seen.has(type)) {
      warnings.push(`config enables adapter "${type}" but no plugin provides it`);
    }
  }

  return {
    plugins: plugins.filter((plugin) => seen.has(plugin.definition.type)),

    warnings,
  };
}
