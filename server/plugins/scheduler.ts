import { defineNitroPlugin } from "nitropack/runtime";
import { startScheduler } from "@src/harness/scheduler";
import { dispatchQueuedRuns } from "@server/utils/run-spawner";

const DISPATCH_INTERVAL_MS = 20_000;

export default defineNitroPlugin(() => {
  void (async () => {
    await dispatchQueuedRuns().catch(() => 0);
    startScheduler();
  })();

  const timer = setInterval(() => {
    void dispatchQueuedRuns().catch(() => 0);
  }, DISPATCH_INTERVAL_MS);
  timer.unref?.();
});
