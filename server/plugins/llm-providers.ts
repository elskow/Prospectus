import { defineNitroPlugin } from "nitropack/runtime";
import { ensureDefaultProvider } from "@src/lib/llm-providers";

export default defineNitroPlugin(() => {
  void ensureDefaultProvider().catch((error) => {
    console.error(`[llm-providers] failed to ensure default provider: ${error instanceof Error ? error.message : String(error)}`);
  });
});
