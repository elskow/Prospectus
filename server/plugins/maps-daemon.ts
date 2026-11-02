import { defineNitroPlugin } from "nitropack/runtime";
import { ensureMapsDaemon } from "@server/utils/maps-daemon-supervisor";

export default defineNitroPlugin(() => {
  void ensureMapsDaemon().catch((error) => {
    console.error(`[maps-daemon] failed to ensure daemon: ${error instanceof Error ? error.message : String(error)}`);
  });
});
