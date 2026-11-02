import type { ResolvedSource } from "@src/harness/source-resolver";

export function selectSourcesForQuery(
  sources: ResolvedSource[],
  sourceYields: { type: string; crawled: number; qualified: number }[],
  query: string,
): ResolvedSource[] {
  const learned = sourceYields.filter((s) => s.crawled >= 5);
  if (learned.length === 0) return sources;
  const yieldMap = new Map(sourceYields.map((s) => [s.type, s]));
  const rateOf = (type: string): number | null => {
    const row = yieldMap.get(type);
    return row && row.crawled >= 5 ? row.qualified / row.crawled : null;
  };
  const viable = sources.filter((source) => {
    const row = yieldMap.get(source.adapter.type);
    return !row || row.crawled < 15 || row.qualified > 0;
  });
  if (viable.length === 0) return sources;
  const best = [...viable].sort((a, b) => (rateOf(b.adapter.type) ?? 0) - (rateOf(a.adapter.type) ?? 0))[0];
  const selected = viable.filter((source) => {
    const rate = rateOf(source.adapter.type);
    return rate === null || rate >= 0.05 || source === best;
  });
  if (selected.length >= 2) return selected;
  const fallback = best ?? viable[0];
  if (!fallback) return selected;
  return selected.includes(fallback) ? selected : [fallback, ...selected];
}

export function marketQueryForSpec(icpSpec: {
  product?: string | null;
  topicsOfInterest?: string[] | null;
  personas?: { title: string }[] | null;
}): string | null {
  if (icpSpec.product) {
    const firstClause = icpSpec.product.split(/[(:]/)[0]?.trim();
    if (firstClause && firstClause.length > 0) return firstClause;
  }
  const topic = icpSpec.topicsOfInterest?.find((t) => t.trim().length > 0);
  if (topic) return topic.trim();
  const personaTitle = icpSpec.personas?.find((p) => p.title.trim().length > 0)?.title;
  if (personaTitle) return personaTitle.trim();
  return null;
}
