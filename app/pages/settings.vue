<script setup lang="ts">
import type { ModelRow } from "@src/db/schema";
import type { StageKey } from "@src/lib/model-settings";
import { toast } from "vue-sonner";
import { ChevronDown } from "lucide-vue-next";

function toastOk(text: string) {
  toast.success(text);
}

function toastFail(err: unknown) {
  toast.error(friendlyError(err));
}

definePageMeta({ middleware: ["auth"] });

useHead({ title: "Settings · Prospectus" });

const { adapters, load: loadAdapters } = useAdapters();
const { credentials, load: loadCredentials, save, test, remove } = useCredentials();

const loading = ref(true);
const openAdapter = ref<string | null>(null);
const expandedRow = ref<string | null>(null);

function toggleRow(key: string, openFormFn?: () => void) {
  if (expandedRow.value === key) {
    expandedRow.value = null;
    openAdapter.value = null;
  } else {
    expandedRow.value = key;
    if (openFormFn) openFormFn();
    else openAdapter.value = null;
  }
}
const formLabel = ref("main");
const formValues = ref<Record<string, string>>({});
const busy = ref(false);

type ModelRowView = ModelRow & { providerLabel: string };

const modelRows = ref<ModelRowView[]>([]);
const modelSelection = ref<Record<StageKey, string> | null>(null);
const modelBusy = ref(false);
const modelOptions = computed(() =>
  modelRows.value.map((row) => ({
    id: `${row.providerId}::${row.id}`,
    label: `${row.providerLabel} · ${row.id}`,
  })),
);
const sourceTypeLabels: Record<string, string> = {};
for (const adapter of adapters.value) sourceTypeLabels[adapter.type] = adapter.label;

const STAGE_LABELS: { key: StageKey; label: string; hint: string }[] = [
  { key: "planner", label: "Query planner", hint: "Turns the ICP into search queries" },
  { key: "extractor", label: "Lead extractor", hint: "Pulls candidates from scraped results" },
  { key: "chat", label: "Chat assistant", hint: "Conversational assistant and memory observations" },
];

async function loadModels() {
  const [list, settings] = await Promise.all([
    $fetch<{ models: ModelRowView[] }>("/api/models"),
    $fetch<{ selection: Record<StageKey, string> }>("/api/settings/model"),
  ]);
  modelRows.value = list.models;
  modelSelection.value = settings.selection;
}

async function syncModels() {
  modelBusy.value = true;
  try {
    await $fetch("/api/models/sync", { method: "POST" });
    await loadModels();
    toastOk("Model catalog synced");
  } catch (err) {
    toastFail(err);
  } finally {
    modelBusy.value = false;
  }
}

async function saveModelSelection() {
  if (!modelSelection.value) return;
  modelBusy.value = true;
  try {
    const res = await $fetch<{ selection: Record<StageKey, string> }>("/api/settings/model", {
      method: "PUT",
      body: modelSelection.value,
    });
    modelSelection.value = res.selection;
    toastOk("Model assignment saved");
  } catch (err) {
    toastFail(err);
  } finally {
    modelBusy.value = false;
  }
}

const CAPTURE_ADAPTERS = new Set(["source:linkedin", "source:x", "source:threads"]);

const sourceAdapters = computed(() =>
  adapters.value.filter((a) => a.enabled && a.kind === "source" && (a.credentialFields.length > 0 || CAPTURE_ADAPTERS.has(a.type))),
);
const credentialsByAdapter = computed(() => {
  const map: Record<string, CredentialRow[]> = {};
  for (const cred of credentials.value) {
    (map[cred.adapterType] ??= []).push(cred);
  }
  return map;
});

function credsFor(adapterType: string): CredentialRow[] {
  return credentialsByAdapter.value[adapterType] ?? [];
}

function isConnected(adapter: AdapterCatalogEntry): boolean {
  const required = adapter.credentialFields.filter((f) => f.required);
  if (required.length === 0) return true;
  return required.every((field) => credsFor(adapter.type).some((c) => c.fieldNames.includes(field.name)));
}

function credentialHealth(adapter: AdapterCatalogEntry): "none" | "unverified" | "verified" | "stale" {
  const rows = credsFor(adapter.type);
  if (rows.length === 0) return "none";
  const verified = rows.some((c) => c.lastVerifiedAt !== null);
  if (!verified) return "unverified";
  const newest = Math.max(...rows.map((c) => new Date(c.lastVerifiedAt ?? 0).getTime()));
  const staleAfterMs = 14 * 24 * 60 * 60 * 1000;
  return Date.now() - newest > staleAfterMs ? "stale" : "verified";
}

function badgeLabel(adapter: AdapterCatalogEntry): string {
  if (!isConnected(adapter)) return "not connected";
  const health = credentialHealth(adapter);
  if (health === "unverified") return "unverified";
  if (health === "stale") return "re-auth needed";
  return "connected";
}

const ADAPTER_DESCRIPTIONS: Record<string, string> = {
  "source:google-maps": "Searches Google Maps for local businesses: ratings, phone numbers, websites, and review counts.",
  "source:linkedin": "Searches LinkedIn company pages and people (founders, owners, CEOs). Needs a valid li_at session cookie.",
  "source:x": "Searches X (Twitter) posts and business accounts. Needs auth_token + ct0 session cookies.",
  "source:threads": "Searches Threads for business posts. Needs a valid sessionid cookie.",
};

const SESSION_COOKIE_FIELDS: Record<string, string> = {
  liAt: "Browser → linkedin.com → DevTools → Application → Cookies → li_at",
  authToken: "Browser → x.com → DevTools → Application → Cookies → auth_token",
  ct0: "Browser → x.com → DevTools → Application → Cookies → ct0",
  sessionId: "Browser → threads.net → DevTools → Application → Cookies → sessionid",
};

const captureJobs = ref<Record<string, { jobId: string | null; status: "idle" | "waiting" | "captured" | "failed"; error: string | null }>>({});
const capturePollTimer = ref<ReturnType<typeof setInterval> | null>(null);

function captureState(adapterType: string) {
  return (captureJobs.value[adapterType] ??= { jobId: null, status: "idle", error: null });
}

async function startBrowserCapture(adapterType: string) {
  busy.value = true;
  const state = captureState(adapterType);
  state.error = null;
  try {
    const res = await $fetch<{ jobId: string; status: string }>("/api/credentials/capture", {
      method: "POST",
      body: { adapterType },
    });
    state.jobId = res.jobId;
    state.status = "waiting";
    capturePollTimer.value ??= setInterval(pollCapture, 2000);
  } catch (err) {
    state.status = "failed";
    state.error = friendlyError(err);
  } finally {
    busy.value = false;
  }
}

async function pollCapture() {
  const active = Object.entries(captureJobs.value).filter(([, s]) => s.status === "waiting" && s.jobId);
  if (active.length === 0) {
    stopCapturePolling();
    return;
  }
  for (const [adapterType, state] of active) {
    try {
      const res = await $fetch<{ status: string; error?: string; credential?: CredentialRow }>(`/api/credentials/capture?jobId=${state.jobId}`);
      if (res.status === "waiting") continue;
      state.jobId = null;
      if (res.status === "captured" && res.credential) {
        state.status = "captured";
        await loadCredentials();
      } else {
        state.status = "failed";
        state.error = res.error ?? "capture failed";
      }
    } catch (err) {
      state.jobId = null;
      state.status = "failed";
      state.error = friendlyError(err);
    }
  }
}

function stopCapturePolling() {
  if (capturePollTimer.value) {
    clearInterval(capturePollTimer.value);
    capturePollTimer.value = null;
  }
}

onBeforeUnmount(stopCapturePolling);

function descriptionFor(adapter: AdapterCatalogEntry): string {
  return ADAPTER_DESCRIPTIONS[adapter.type] ?? "";
}

function relativeDate(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function openForm(adapter: AdapterCatalogEntry) {
  openAdapter.value = adapter.type;
  formLabel.value = "main";
  formValues.value = Object.fromEntries(adapter.credentialFields.map((f) => [f.name, ""]));
}

async function submitForm(adapter: AdapterCatalogEntry) {
  if (!openAdapter.value) return;
  busy.value = true;
  try {
    await save(openAdapter.value, formLabel.value, formValues.value);
    toastOk("Credentials saved.");
    openAdapter.value = null;
  } catch (err) {
    toastFail(err);
  } finally {
    busy.value = false;
  }
}

async function testCredential(adapterType: string, label: string) {
  busy.value = true;
  try {
    const result = await test(adapterType, label);
    if (result.ok) {
      toastOk("Connection verified.");
    } else {
      toast.error(`Missing fields: ${result.missing.join(", ")}`);
    }
    await loadCredentials();
  } catch (err) {
    toastFail(err);
  } finally {
    busy.value = false;
  }
}

async function deleteCredential(adapterType: string, label: string) {
  busy.value = true;
  try {
    await remove(adapterType, label);
    toastOk("Credential deleted.");
  } catch (err) {
    toastFail(err);
  } finally {
    busy.value = false;
  }
}

const googleConnected = computed(() => credsFor("sink:google-sheets").some((c) => c.label === "google-oauth"));

const connecting = ref(false);

async function connectGoogle() {
  connecting.value = true;
  try {
    const res = await $fetch<{ url: string }>("/api/auth/google/connect");
    await navigateTo(res.url, { external: true });
  } catch (err) {
    toastFail(err);
    connecting.value = false;
  }
}

onMounted(async () => {
  await Promise.all([loadAdapters(), loadCredentials(), loadModels().catch(() => {})]);
  loading.value = false;
});
</script>

<template>
  <div class="mx-auto h-full w-full max-w-7xl space-y-10 overflow-y-auto px-8 py-8">
    <div class="flex items-start justify-between">
      <div>
        <h1 class="text-xl font-semibold tracking-tight">Platform settings</h1>
        <p class="mt-1 text-sm text-muted-foreground">Lead sources, exports, and models shared by the whole platform.</p>
      </div>
    </div>

    <div v-if="loading" class="space-y-3">
      <div v-for="i in 3" :key="i" class="h-28 animate-pulse rounded-xl border border-border bg-background" />
    </div>

    <template v-else>
      <section aria-labelledby="sources-heading">
        <h2 id="sources-heading" class="text-sm font-semibold uppercase tracking-widest text-muted-foreground">Lead sources</h2>
        <p class="mt-1 text-sm text-muted-foreground">Every run queries all connected sources in parallel. Runs skip sources that are not connected.</p>

        <div class="mt-4 divide-y divide-border overflow-hidden rounded-xl border border-border">
          <div v-for="adapter in sourceAdapters" :key="adapter.type">
            <button
              type="button"
              class="flex w-full items-center gap-4 bg-card px-5 py-4 text-left transition-colors hover:bg-muted/40"
              :aria-expanded="expandedRow === `source:${adapter.type}`"
              @click="toggleRow(`source:${adapter.type}`, () => openForm(adapter))"
            >
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-3">
                  <span class="text-sm font-semibold">{{ adapter.label }}</span>
                  <span
                    class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium"
                    :class="{
                      'bg-success/10 text-success': isConnected(adapter) && (credentialHealth(adapter) === 'verified' || credentialHealth(adapter) === 'none'),
                      'bg-warning/10 text-warning': credentialHealth(adapter) === 'unverified' || credentialHealth(adapter) === 'stale',
                      'bg-muted text-muted-foreground': !isConnected(adapter),
                    }"
                  >
                    <span class="size-1.5 rounded-full bg-current" aria-hidden="true" />
                    {{ badgeLabel(adapter) }}
                  </span>
                </div>
                <p v-if="credsFor(adapter.type).length > 0 || descriptionFor(adapter)" class="mt-0.5 truncate text-xs text-muted-foreground">
                  {{
                    credsFor(adapter.type).length > 0
                      ? `${credsFor(adapter.type).length} credential${credsFor(adapter.type).length === 1 ? "" : "s"} saved · ${credsFor(adapter.type)[0].lastVerifiedAt ? `verified ${relativeDate(credsFor(adapter.type)[0].lastVerifiedAt)}` : "not verified yet"}`
                      : descriptionFor(adapter)
                  }}
                </p>
              </div>
              <ChevronDown
                class="size-4 shrink-0 text-muted-foreground transition-transform"
                :class="expandedRow === `source:${adapter.type}` ? 'rotate-180' : ''"
                aria-hidden="true"
              />
            </button>

            <div v-if="expandedRow === `source:${adapter.type}`" class="space-y-4 border-t border-border bg-muted/30 px-5 py-4">
              <div v-if="CAPTURE_ADAPTERS.has(adapter.type)" class="space-y-2">
                <Button
                  variant="outline"
                  size="sm"
                  :disabled="busy || captureState(adapter.type).status === 'waiting'"
                  @click="startBrowserCapture(adapter.type)"
                >
                  {{ captureState(adapter.type).status === "waiting" ? "Waiting for login…" : "Log in with browser" }}
                </Button>
                <p v-if="captureState(adapter.type).status === 'waiting'" class="text-xs text-muted-foreground">
                  A browser window opened — log in there. Cookies are captured automatically when login completes. Closes after 5 minutes.
                </p>
                <p v-else-if="captureState(adapter.type).status === 'failed'" class="text-xs text-destructive">
                  {{ captureState(adapter.type).error ?? "Capture failed" }}
                </p>
                <p v-else-if="captureState(adapter.type).status === 'captured'" class="text-xs text-success">Cookies captured and saved.</p>
                <p class="text-xs text-muted-foreground">…or paste cookies manually below.</p>
              </div>
              <div v-if="credsFor(adapter.type).length > 0" class="space-y-2">
                <div
                  v-for="cred in credsFor(adapter.type)"
                  :key="cred.id"
                  class="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2.5"
                >
                  <div>
                    <p class="text-sm font-medium">{{ cred.label }}</p>
                    <p class="text-xs text-muted-foreground">
                      {{ cred.lastVerifiedAt ? `verified ${formatDateTime(cred.lastVerifiedAt)}` : "saved, not verified" }}
                    </p>
                  </div>
                  <div class="flex gap-2">
                    <Button variant="outline" size="sm" :disabled="busy" @click="testCredential(adapter.type, cred.label)">Test</Button>
                    <Button variant="ghost" size="sm" :disabled="busy" @click="deleteCredential(adapter.type, cred.label)">Delete</Button>
                  </div>
                </div>
              </div>

              <form v-if="openAdapter === adapter.type" class="space-y-3" @submit.prevent="submitForm(adapter)">
                <div v-for="field in adapter.credentialFields" :key="field.name" class="space-y-1.5">
                  <Label :for="`${adapter.type}-${field.name}`">{{ field.label }}</Label>
                  <Input
                    :id="`${adapter.type}-${field.name}`"
                    v-model="formValues[field.name]"
                    :type="field.secret ? 'password' : 'text'"
                    :required="field.required !== false"
                    :placeholder="field.secret ? '••••••••' : ''"
                  />
                  <p v-if="SESSION_COOKIE_FIELDS[field.name]" class="text-xs text-muted-foreground">{{ SESSION_COOKIE_FIELDS[field.name] }}</p>
                </div>
                <div class="flex items-center gap-2 pt-1">
                  <Button type="submit" size="sm" :disabled="busy">Save</Button>
                  <Button type="button" variant="ghost" size="sm" @click="openAdapter = null">Cancel</Button>
                </div>
              </form>
              <div v-else class="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" @click="openForm(adapter)">
                  {{ credsFor(adapter.type).length > 0 ? "Update credentials" : "Connect" }}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="exports-heading">
        <h2 id="exports-heading" class="text-sm font-semibold uppercase tracking-widest text-muted-foreground">Exports</h2>
        <p class="mt-1 text-sm text-muted-foreground">Where qualified leads land after each run.</p>

        <div class="mt-4 divide-y divide-border overflow-hidden rounded-xl border border-border">
          <div>
            <button
              type="button"
              class="flex w-full items-center gap-4 bg-card px-5 py-4 text-left transition-colors hover:bg-muted/40"
              :aria-expanded="expandedRow === 'export:sheets'"
              @click="toggleRow('export:sheets')"
            >
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-3">
                  <span class="text-sm font-semibold">Google Sheets</span>
                  <span
                    class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium"
                    :class="googleConnected ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'"
                  >
                    <span class="size-1.5 rounded-full bg-current" aria-hidden="true" />
                    {{ googleConnected ? "connected" : "not connected" }}
                  </span>
                </div>
                <p class="mt-0.5 truncate text-xs text-muted-foreground">Syncs qualified leads into your spreadsheet after every run</p>
              </div>
              <ChevronDown
                class="size-4 shrink-0 text-muted-foreground transition-transform"
                :class="expandedRow === 'export:sheets' ? 'rotate-180' : ''"
                aria-hidden="true"
              />
            </button>
            <div v-if="expandedRow === 'export:sheets'" class="border-t border-border bg-muted/30 px-5 py-4">
              <Button size="sm" :disabled="connecting" @click="connectGoogle">
                {{ connecting ? "Redirecting…" : googleConnected ? "Reconnect Google" : "Connect Google" }}
              </Button>
            </div>
          </div>
        </div>
      </section>

      <section aria-labelledby="models-heading">
        <div class="flex items-center justify-between">
          <div>
            <h2 id="models-heading" class="text-sm font-semibold uppercase tracking-widest text-muted-foreground">Models</h2>
            <p class="mt-1 text-sm text-muted-foreground">
              Pick which provider and model each agent stage uses. Changes apply to the next run or chat message.
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" :disabled="modelBusy" @click="syncModels">Sync catalog</Button>
        </div>

        <div v-if="modelRows.length === 0" class="mt-4 rounded-xl border border-border bg-card px-5 py-4 text-sm text-muted-foreground">
          No models synced yet. Add a provider and click "Sync catalog" to fetch its model list.
        </div>

        <div v-else class="mt-4 divide-y divide-border overflow-hidden rounded-xl border border-border">
          <div v-for="stageInfo in STAGE_LABELS" :key="stageInfo.key" class="flex items-center justify-between gap-4 bg-card px-5 py-3.5">
            <div class="min-w-0">
              <p class="text-sm font-medium">{{ stageInfo.label }}</p>
              <p class="text-xs text-muted-foreground">{{ stageInfo.hint }}</p>
            </div>
            <ModelCombobox
              v-if="modelSelection"
              :models="modelOptions"
              :model-value="modelSelection[stageInfo.key]"
              @update:model-value="
                (value: string) => {
                  if (modelSelection) modelSelection[stageInfo.key] = value;
                }
              "
            />
          </div>
        </div>

        <div v-if="modelSelection && modelRows.length > 0" class="mt-3 flex justify-end">
          <Button type="button" size="sm" :disabled="modelBusy" @click="saveModelSelection">Save assignments</Button>
        </div>
      </section>
    </template>
  </div>
</template>
