export interface DirectoryRow {
  name: string;
  website?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  city?: string | null;
  province?: string | null;
  country?: string | null;
  industry?: string | null;
  sourceUrl?: string | null;
  raw?: Record<string, unknown> | null;
}

export interface DirectoryPage {
  rows: DirectoryRow[];
  cursor: string | null;
}

export interface DirectoryAdapter {
  id: string;
  label: string;
  defaultPageSize: number;
  firstPage(): Promise<DirectoryPage>;
  nextPage(cursor: string): Promise<DirectoryPage>;
}

const adapters = new Map<string, DirectoryAdapter>();

export function registerDirectoryAdapter(adapter: DirectoryAdapter): void {
  adapters.set(adapter.id, adapter);
}

export function getDirectoryAdapter(id: string): DirectoryAdapter | undefined {
  return adapters.get(id);
}

export function listDirectoryAdapters(): { id: string; label: string }[] {
  return [...adapters.values()].map((adapter) => ({ id: adapter.id, label: adapter.label }));
}
