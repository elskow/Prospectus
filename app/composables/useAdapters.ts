export interface AdapterCatalogEntry {
  type: string;
  kind: "source" | "watch" | "enrichment" | "sink";
  label: string;
  credentialFields: { name: string; label: string; secret: boolean; required?: boolean }[];
  enabled: boolean;
}

export interface CredentialRow {
  id: string;
  adapterType: string;
  label: string;
  fieldNames: string[];
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const useAdapters = () => {
  const adapters = useState<AdapterCatalogEntry[]>("adapters:catalog", () => []);

  const load = async () => {
    const res = await $fetch<{ adapters: AdapterCatalogEntry[] }>("/api/adapters");
    adapters.value = res.adapters;
    return res.adapters;
  };

  return { adapters, load };
};

export const useCredentials = () => {
  const credentials = useState<CredentialRow[]>("credentials:list", () => []);

  const load = async () => {
    const res = await $fetch<{ credentials: CredentialRow[] }>("/api/credentials");
    credentials.value = res.credentials;
    return res.credentials;
  };

  const save = async (adapterType: string, label: string, values: Record<string, string>) => {
    await $fetch("/api/credentials", {
      method: "POST",
      body: { adapterType, label, values },
    });
    await load();
  };

  const test = async (adapterType: string, label: string) => {
    return $fetch<{ ok: boolean; missing: string[]; verifiedAt: string }>("/api/credentials/test", {
      method: "POST",
      body: { adapterType, label },
    });
  };

  const remove = async (adapterType: string, label: string) => {
    await $fetch("/api/credentials", {
      method: "DELETE",
      query: { adapterType, label },
    });
    await load();
  };

  return { credentials, load, save, test, remove };
};
