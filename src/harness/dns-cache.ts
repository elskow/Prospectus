import { resolveMx } from "node:dns/promises";

const POSITIVE_TTL_MS = 30 * 60_000;
const NEGATIVE_TTL_MS = 10 * 60_000;
const MX_TIMEOUT_MS = 5_000;

const cache = new Map<string, { value: boolean; expires: number }>();

export async function hasMailExchange(domain: string): Promise<boolean> {
  const now = Date.now();
  const hit = cache.get(domain);
  if (hit && hit.expires > now) return hit.value;

  const signal = AbortSignal.timeout(MX_TIMEOUT_MS);
  const timedOut = Promise.withResolvers<number>();
  signal.addEventListener("abort", () => timedOut.resolve(0), { once: true });

  const count = await Promise.race([
    resolveMx(domain).then(
      (records) => records.length,
      () => 0,
    ),
    timedOut.promise,
  ]);
  const value = count > 0;
  cache.set(domain, { value, expires: now + (value ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS) });
  return value;
}
