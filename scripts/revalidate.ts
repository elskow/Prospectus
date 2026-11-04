import { revalidateCompanies } from "@src/harness/revalidate";

const argValue = (name: string): string | undefined => {
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (inline !== undefined) return inline.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0) {
    const next = process.argv[idx + 1];
    if (next !== undefined && !next.startsWith("--")) return next;
  }
  return undefined;
};

const country = argValue("country");
const rule = argValue("rule");
const limitRaw = argValue("limit");
const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;

if (limitRaw !== undefined && (!Number.isFinite(limit) || (limit as number) <= 0)) {
  console.error(`invalid --limit: ${limitRaw}`);
  process.exit(2);
}

try {
  const result = await revalidateCompanies({ country, rule, limit });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`revalidate failed: ${message}`);
  process.exit(1);
}
