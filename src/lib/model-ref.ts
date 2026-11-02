export interface ParsedModelRef {
  providerId: string | null;
  model: string;
}

const SEPARATOR = "::";

export function parseModelRef(ref: string): ParsedModelRef {
  const index = ref.indexOf(SEPARATOR);
  if (index === -1) {
    return { providerId: null, model: ref };
  }

  return { providerId: ref.slice(0, index), model: ref.slice(index + SEPARATOR.length) };
}

export function formatModelRef(providerId: string, model: string): string {
  return `${providerId}${SEPARATOR}${model}`;
}
