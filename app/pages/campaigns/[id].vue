<script setup lang="ts">
import { ChevronDown, ChevronLeft, RefreshCw } from "lucide-vue-next";
import { toast } from "vue-sonner";

definePageMeta({ middleware: ["auth"] });

const route = useRoute();
const campaignId = route.params.id as string;

interface Campaign {
  id: string;
  name: string;
  niche: string;
  area: string | null;
  notes: string | null;
  exclusions: string[];
  status: string;
  dailyLeadGoal: number;
  maxTurnsPerRun: number | null;
  scheduleEnabled: boolean;
  scheduleIntervalHours: number;
  sinkConfig: { googleSheets?: { spreadsheetId?: string; sheetName?: string } };
  exportMode: "one_per_company" | "all_contacts";
}

interface LeadContactRow {
  id: string;
  name: string | null;
  title: string | null;
  email: string | null;
  emailVerification: string | null;
  phone: string | null;
  phoneNormalized: string | null;
  whatsapp: string | null;
  linkedinUrl: string | null;
  isDecisionMaker: boolean | null;
}

interface LeadRow {
  id: string;
  status: string;
  enrichmentStatus: string;
  sheetSyncedAt: string | null;
  createdAt: string;
  companyName: string;
  companyWebsite: string | null;
  companyPhone: string | null;
  companyCity: string | null;
  companyIndustry: string | null;
  contacts: LeadContactRow[];
  sourceLabels: string[];
}

interface CampaignTotals {
  total: number;
  ready: number;
  synced: number;
}

const campaign = ref<Campaign | null>(null);
const totals = ref<CampaignTotals>({ total: 0, ready: 0, synced: 0 });
const leads = ref<LeadRow[]>([]);
const loading = ref(true);
const statusFilter = ref<"all" | "ready" | "new" | "synced">("all");
const expandedId = ref<string | null>(null);

interface QueueState {
  queueId: string | null;
  status: "idle" | "queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled";
  progress: { stage: string; message: string; at: string }[];
  cursor?: string | null;
  error: string | null;
  result: { status: string; turnsUsed: number; costUsd?: number; newReadyLeads: number; totalReadyLeads: number } | null;
}

const queue = ref<QueueState>({ queueId: null, status: "idle", progress: [], cursor: null, error: null, result: null });
const running = computed(() => ["queued", "running"].includes(queue.value.status));
const stopping = ref(false);
let pollTimer: ReturnType<typeof setInterval> | null = null;
const progressEnd = ref<HTMLElement | null>(null);

const stageClass = (stage: string): string => {
  switch (stage) {
    case "plan":
      return "text-chart-5";
    case "scrape":
      return "text-chart-4";
    case "extract":
      return "text-chart-3";
    case "persist":
      return "text-chart-2";
    case "harvest":
      return "text-warning";
    case "turn":
      return "text-foreground";
    case "done":
      return "text-success";
    default:
      return "text-foreground";
  }
};

const shortTime = (at: string): string => formatClock(at);

interface RunLogEvent {
  id?: string;
  stage: string;
  message: string;
  at: string;
}
const persistedEvents = ref<RunLogEvent[]>([]);
const logLines = computed<RunLogEvent[]>(() =>
  running.value ? queue.value.progress.map((p) => ({ stage: p.stage, message: p.message, at: p.at })) : persistedEvents.value,
);

async function loadEvents() {
  try {
    const res = await $fetch<{ events: RunLogEvent[] }>(`/api/campaigns/${campaignId}/run-events`, {
      query: { limit: 150 },
    });
    persistedEvents.value = res.events;
  } catch {}
}

async function load() {
  loading.value = true;
  try {
    const res = await $fetch<{ campaign: Campaign; totals: CampaignTotals; leads: LeadRow[] }>(`/api/campaigns/${campaignId}/prospects`);
    campaign.value = res.campaign;
    totals.value = res.totals;
    leads.value = res.leads;
    const marketRes = await $fetch<{ markets: MarketRow[]; summary: typeof marketSummary.value }>(`/api/campaigns/${campaignId}/markets`).catch(() => null);
    if (marketRes) {
      markets.value = marketRes.markets;
      marketSummary.value = marketRes.summary;
    }
  } catch (err) {
    toast.error(friendlyError(err));
  } finally {
    loading.value = false;
  }
}

async function setSchedule(enabled: boolean) {
  await $fetch(`/api/campaigns/${campaignId}`, { method: "PATCH", body: { scheduleEnabled: enabled } });
  await load();
}

const settingsOpen = ref(false);
const settingsBusy = ref(false);
const goalInput = ref(0);
const maxTurnsInput = ref<number | null>(null);
const intervalInput = ref(4);
const exclusionsInput = ref("");
const notesInput = ref("");
const sheetIdInput = ref("");
const sheetNameInput = ref("");
const exportModeInput = ref<"one_per_company" | "all_contacts">("one_per_company");

function openSettings() {
  if (!campaign.value) return;
  goalInput.value = campaign.value.dailyLeadGoal;
  maxTurnsInput.value = campaign.value.maxTurnsPerRun ?? null;
  intervalInput.value = campaign.value.scheduleIntervalHours;
  exclusionsInput.value = campaign.value.exclusions.join(", ");
  notesInput.value = campaign.value.notes ?? "";
  sheetIdInput.value = campaign.value.sinkConfig?.googleSheets?.spreadsheetId ?? "";
  sheetNameInput.value = campaign.value.sinkConfig?.googleSheets?.sheetName ?? "";
  exportModeInput.value = campaign.value.exportMode ?? "one_per_company";
  settingsOpen.value = true;
}

async function saveSettings() {
  if (!campaign.value) return;
  settingsBusy.value = true;
  try {
    await $fetch(`/api/campaigns/${campaignId}`, {
      method: "PATCH",
      body: {
        dailyLeadGoal: goalInput.value,
        maxTurnsPerRun: maxTurnsInput.value === null ? null : Number(maxTurnsInput.value),
        scheduleIntervalHours: intervalInput.value,
        exclusions: exclusionsInput.value
          .split(/[,\n]/)
          .map((t) => t.trim())
          .filter(Boolean),
        notes: notesInput.value.trim() || null,
        exportMode: exportModeInput.value,
        sinkConfig: {
          googleSheets: {
            ...(sheetIdInput.value.trim() ? { spreadsheetId: sheetIdInput.value.trim() } : {}),
            ...(sheetNameInput.value.trim() ? { sheetName: sheetNameInput.value.trim() } : {}),
          },
        },
      },
    });
    await load();
  } finally {
    settingsBusy.value = false;
  }
}

async function pollStatus() {
  try {
    const since = queue.value.cursor;
    const res = await $fetch<QueueState>(`/api/campaigns/${campaignId}/run-status`, {
      query: since ? { since } : {},
    });
    const appended = res.progress;
    queue.value = {
      ...res,
      progress: since && res.status === queue.value.status ? [...queue.value.progress, ...appended] : appended,
    };
    if (appended.length > 0) {
      await nextTick();
      progressEnd.value?.scrollIntoView({ block: "nearest" });
    }
    if (!running.value && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
      await load();
      setTimeout(loadEvents, 1500);
    }
  } catch {}
}

async function run() {
  if (running.value) return;
  try {
    const res = await $fetch<{ queueId: string }>(`/api/campaigns/${campaignId}/run-queue`, {
      method: "POST",
      body: {},
    });
    queue.value = { queueId: res.queueId, status: "queued", progress: [], error: null, result: null };
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollStatus, 1500);
    await pollStatus();
  } catch (error) {
    queue.value = {
      queueId: null,
      status: "failed",
      progress: [],
      error: friendlyError(error),
      result: null,
    };
  }
}

async function stopRun() {
  if (!queue.value.queueId || stopping.value) return;
  stopping.value = true;
  try {
    await $fetch(`/api/campaigns/${campaignId}/run-cancel`, {
      method: "POST",
      body: { queueId: queue.value.queueId },
    });
    await pollStatus();
  } catch {
  } finally {
    stopping.value = false;
  }
}

onMounted(() => {
  loadEvents();
  pollStatus();
  pollTimer = setInterval(pollStatus, 2500);
});

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer);
});

const readyCount = computed(() => totals.value.ready + totals.value.synced);
const companyCount = computed(() => totals.value.total);
const collectingCount = computed(() => Math.max(0, totals.value.total - readyCount.value));

const filteredLeads = computed(() => {
  if (statusFilter.value === "all") return leads.value;
  if (statusFilter.value === "ready") return leads.value.filter((l) => l.status === "ready" || l.status === "synced");
  return leads.value.filter((l) => l.status === statusFilter.value);
});

const filters = [
  { value: "all", label: "All" },
  { value: "ready", label: "Ready" },
  { value: "new", label: "Collecting" },
  { value: "synced", label: "Synced" },
] as const;

function toggleExpand(id: string) {
  expandedId.value = expandedId.value === id ? null : id;
}

interface MarketRow {
  id: string;
  city: string;
  sector: string;
  status: "pending" | "active" | "saturated";
  discovered: number;
  emailed: number;
}

const markets = ref<MarketRow[]>([]);
const marketSummary = ref({ total: 0, active: 0, pending: 0, saturated: 0 });
const newMarketCity = ref("");
const marketBusy = ref(false);

async function addMarket() {
  const city = newMarketCity.value.trim();
  if (city.length < 2) return;
  marketBusy.value = true;
  try {
    await $fetch(`/api/campaigns/${campaignId}/markets`, { method: "POST", body: { city } });
    newMarketCity.value = "";
    await load();
    toast.success(`Market "${city}" queued.`);
  } catch (err) {
    toast.error(friendlyError(err));
  } finally {
    marketBusy.value = false;
  }
}
const recrawlBusy = ref<string | null>(null);

async function recrawl(lead: LeadRow) {
  recrawlBusy.value = lead.id;
  try {
    await $fetch(`/api/campaigns/${campaignId}/prospects/${lead.id}/recrawl`, { method: "POST" });
    toast.success(`Re-crawling contacts for ${lead.companyName}.`);
    await load();
  } catch (err) {
    toast.error(friendlyError(err));
  } finally {
    recrawlBusy.value = null;
  }
}

function contactLine(lead: LeadRow): string {
  const withEmail = lead.contacts.find((c) => c.email);
  const dm = lead.contacts.find((c) => c.isDecisionMaker) ?? lead.contacts[0];
  const chosen = withEmail ?? dm;
  if (!chosen) return "—";
  return [chosen.email, chosen.name, chosen.phoneNormalized ?? chosen.phone].filter(Boolean).join(" · ") || "—";
}

function formatDate(iso: string | null) {
  return formatDateTime(iso);
}

onMounted(load);
</script>

<template>
  <div class="mx-auto h-full w-full max-w-7xl space-y-8 overflow-y-auto px-8 py-8">
    <div v-if="loading" class="space-y-4">
      <div class="h-24 animate-pulse rounded-lg bg-card" />
      <div class="h-64 animate-pulse rounded-lg bg-card" />
    </div>
    <template v-else-if="campaign">
      <NuxtLink to="/campaigns" class="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        ><ChevronLeft class="size-4" aria-hidden="true" /> All campaigns</NuxtLink
      >

      <div class="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div>
          <div class="flex items-center gap-3">
            <span
              class="size-2 shrink-0 rounded-full"
              :class="campaign.status === 'active' ? 'bg-success' : 'bg-muted-foreground/40'"
              :title="`campaign is ${campaign.status}`"
            />
            <h1 class="text-xl font-semibold tracking-tight">{{ campaign.name }}</h1>
          </div>
          <p class="mt-1 text-sm text-muted-foreground">
            {{ campaign.niche }}<template v-if="campaign.area"> · {{ campaign.area }}</template> ·
            {{ campaign.scheduleEnabled ? `every ${campaign.scheduleIntervalHours}h` : "manual runs" }}
          </p>
          <div v-if="campaign.exclusions.length > 0" class="mt-2 flex flex-wrap gap-1">
            <span v-for="term in campaign.exclusions" :key="term" class="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive">
              ×{{ term }}
            </span>
          </div>
        </div>
        <div class="flex items-center gap-2">
          <Button size="sm" variant="outline" @click="openSettings">Settings</Button>
          <Button size="sm" variant="outline" @click="setSchedule(!campaign.scheduleEnabled)">
            {{ campaign.scheduleEnabled ? "Disable schedule" : "Enable schedule" }}
          </Button>
          <a :href="`/api/campaigns/${campaignId}/prospects.csv`" download class="inline-flex">
            <Button size="sm" variant="outline">Download CSV</Button>
          </a>
          <Button :disabled="running" @click="run">{{ running ? "Running…" : "Run now" }}</Button>
        </div>
      </div>

      <Card class="mt-6">
        <CardHeader class="pb-2">
          <CardTitle class="text-sm">What this campaign hunts</CardTitle>
          <CardDescription class="text-xs">A row becomes a prospect when the company has an email address.</CardDescription>
        </CardHeader>
        <CardContent class="space-y-2 text-sm">
          <p>{{ campaign.notes || "No extra notes." }}</p>
          <div class="flex flex-wrap gap-2 pt-1">
            <Badge variant="secondary"><span class="text-muted-foreground">Daily goal:</span>&nbsp;{{ campaign.dailyLeadGoal }} companies with email</Badge>
          </div>
        </CardContent>
      </Card>

      <Card v-if="markets.length > 0" class="mt-6">
        <CardHeader class="pb-2">
          <CardTitle class="text-sm">Markets</CardTitle>
          <CardDescription class="text-xs">
            {{ marketSummary.active }} active · {{ marketSummary.pending }} pending · {{ marketSummary.saturated }} saturated
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-1.5 text-sm">
          <div v-for="market in markets.slice(0, 6)" :key="market.id" class="flex items-center justify-between gap-3">
            <span class="truncate">{{ market.city }} × {{ market.sector }}</span>
            <span class="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
              <span class="tabular-nums">{{ market.emailed }} emailed</span>
              <Badge :variant="market.status === 'saturated' ? 'secondary' : market.status === 'active' ? 'default' : 'outline'">{{ market.status }}</Badge>
            </span>
          </div>
          <p v-if="markets.length > 6" class="text-xs text-muted-foreground">and {{ markets.length - 6 }} more market(s)</p>
          <div class="flex items-center gap-2 pt-2">
            <Input v-model="newMarketCity" placeholder="Add city (e.g. Semarang)" class="h-8" />
            <Button size="sm" variant="outline" :disabled="marketBusy || newMarketCity.trim().length < 2" @click="addMarket">
              {{ marketBusy ? "Adding…" : "Add market" }}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div class="mt-6 flex items-center gap-6 text-sm">
        <div class="flex items-baseline gap-1.5">
          <span class="text-xl font-semibold tabular-nums">{{ companyCount }}</span>
          <span class="text-muted-foreground">companies</span>
        </div>
        <div class="flex items-baseline gap-1.5">
          <span class="text-xl font-semibold tabular-nums text-success">{{ readyCount }}</span>
          <span class="text-muted-foreground">ready (email)</span>
        </div>
        <div class="flex items-baseline gap-1.5">
          <span class="text-xl font-semibold tabular-nums text-warning">{{ collectingCount }}</span>
          <span class="text-muted-foreground">collecting</span>
        </div>
      </div>

      <Card v-if="logLines.length > 0 || running" class="mt-6">
        <CardHeader class="flex-row items-center justify-between pb-2">
          <CardTitle class="text-sm">Run log</CardTitle>
          <span v-if="running" class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <span class="size-1.5 rounded-full bg-warning" aria-hidden="true" />
            {{ queue.status }}
            <Button size="sm" variant="outline" class="border-destructive/40 text-destructive hover:bg-destructive/10" :disabled="stopping" @click="stopRun">
              {{ stopping ? "Stopping…" : "Stop" }}
            </Button>
          </span>
          <Badge v-else-if="queue.status === 'paused'" variant="secondary">paused · resume to continue</Badge>
          <Badge v-else-if="queue.result" :variant="queue.result.status === 'succeeded' ? 'default' : 'destructive'">
            {{ queue.result.status }}
          </Badge>
        </CardHeader>
        <CardContent>
          <div
            class="max-h-72 space-y-0.5 overflow-y-auto rounded-md border border-border bg-background/50 p-3 font-mono text-xs"
            role="log"
            aria-label="Run log"
          >
            <div v-for="(line, i) in logLines" :key="line.id ?? i" class="flex gap-2">
              <span class="shrink-0 text-muted-foreground/50 tabular-nums">{{ shortTime(line.at) }}</span>
              <span class="shrink-0" :class="stageClass(line.stage)">{{ line.stage }}</span>
              <span class="text-muted-foreground">{{ line.message }}</span>
            </div>
            <div v-if="running" class="flex gap-2 text-muted-foreground/60">
              <span class="shrink-0">···</span>
              <span>working…</span>
            </div>
            <div ref="progressEnd" />
          </div>
          <p v-if="queue.result && typeof queue.result.costUsd === 'number'" class="pt-2 text-muted-foreground">
            {{ queue.result.turnsUsed }} turns · ~${{ queue.result.costUsd.toFixed(4) }} LLM spend · +{{ queue.result.newReadyLeads }} prospect rows
          </p>
        </CardContent>
      </Card>
      <p v-if="queue.error" class="mt-4 text-sm text-destructive" role="alert">{{ queue.error }}</p>

      <div class="mt-8 flex items-center justify-between">
        <h2 class="text-base font-semibold tracking-tight">Prospects</h2>
        <div v-if="leads.length > 0" class="flex items-center gap-1 rounded-md border border-border p-0.5" role="group" aria-label="Filter prospects by status">
          <button
            v-for="f in filters"
            :key="f.value"
            type="button"
            class="rounded px-2.5 py-1 text-xs transition-colors"
            :class="statusFilter === f.value ? 'bg-secondary font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'"
            :aria-pressed="statusFilter === f.value"
            @click="statusFilter = f.value"
          >
            {{ f.label }}
          </button>
        </div>
      </div>

      <div v-if="leads.length === 0" class="mt-3 rounded-lg border border-dashed border-border bg-card p-8 text-center">
        <p class="text-sm font-medium">No prospects yet</p>
        <p class="mt-1 text-sm text-muted-foreground">Hit "Run now" to start hunting.</p>
      </div>
      <div v-else-if="filteredLeads.length === 0" class="mt-3 rounded-lg border border-dashed border-border bg-card p-8 text-center">
        <p class="text-sm font-medium">No {{ statusFilter }} prospects</p>
        <p class="mt-1 text-sm text-muted-foreground">Switch the filter to see the rest of the list.</p>
      </div>
      <div v-else class="mt-3 overflow-hidden rounded-lg border border-border">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-border bg-card text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th class="px-4 py-2.5 font-medium">Company</th>
              <th class="px-4 py-2.5 font-medium">Best contact</th>
              <th class="px-4 py-2.5 font-medium">Status</th>
              <th class="px-4 py-2.5 font-medium">Found</th>
              <th class="w-8 px-2 py-2.5"><span class="sr-only">Expand</span></th>
            </tr>
          </thead>
          <tbody>
            <template v-for="lead in filteredLeads" :key="lead.id">
              <tr
                class="cursor-pointer border-b border-border transition-colors hover:bg-card/60"
                :aria-expanded="expandedId === lead.id"
                @click="toggleExpand(lead.id)"
              >
                <td class="max-w-xs px-4 py-3">
                  <p class="font-medium">{{ lead.companyName }}</p>
                  <a
                    v-if="lead.companyWebsite"
                    :href="lead.companyWebsite"
                    target="_blank"
                    rel="noopener"
                    class="mt-0.5 block max-w-[16rem] truncate text-xs underline underline-offset-2 text-muted-foreground hover:text-foreground"
                    @click.stop
                    >{{ lead.companyWebsite }}</a
                  >
                </td>
                <td class="max-w-xs px-4 py-3 text-muted-foreground">{{ contactLine(lead) }}</td>
                <td class="px-4 py-3">
                  <Badge :variant="lead.status === 'ready' ? 'default' : lead.status === 'synced' ? 'secondary' : 'outline'">{{ lead.status }}</Badge>
                </td>
                <td class="px-4 py-3 tabular-nums text-muted-foreground">{{ formatDate(lead.createdAt) }}</td>
                <td class="px-2 py-3 text-center text-muted-foreground">
                  <ChevronDown class="mx-auto size-4 transition-transform" :class="expandedId === lead.id ? 'rotate-180' : ''" aria-hidden="true" />
                </td>
              </tr>
              <tr v-if="expandedId === lead.id" class="border-b border-border bg-card/40">
                <td colspan="5" class="px-4 py-4">
                  <div class="grid gap-4 md:grid-cols-2">
                    <div>
                      <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Company details</p>
                      <div class="mt-4 grid grid-cols-2 gap-3 text-xs">
                        <div v-if="lead.companyIndustry">
                          <p class="font-medium uppercase tracking-wide text-muted-foreground">Category</p>
                          <p class="mt-1">{{ lead.companyIndustry }}</p>
                        </div>
                        <div v-if="lead.companyPhone">
                          <p class="font-medium uppercase tracking-wide text-muted-foreground">Company phone</p>
                          <p class="mt-1 tabular-nums">{{ lead.companyPhone }}</p>
                        </div>
                        <div v-if="lead.sourceLabels.length > 0">
                          <p class="font-medium uppercase tracking-wide text-muted-foreground">Found via</p>
                          <p class="mt-1">{{ lead.sourceLabels.join(", ") }}</p>
                        </div>
                      </div>
                    </div>
                    <div class="space-y-4">
                      <div v-if="lead.contacts.length > 0">
                        <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Contacts</p>
                        <div class="mt-1.5 space-y-2">
                          <div
                            v-for="contact in lead.contacts"
                            :key="contact.id"
                            class="rounded-md border px-3 py-2"
                            :class="
                              contact.email || contact.phone || contact.phoneNormalized || contact.whatsapp || contact.linkedinUrl
                                ? 'border-border'
                                : 'border-dashed border-muted-foreground/30 opacity-70'
                            "
                          >
                            <p class="text-sm font-medium">
                              {{ contact.name || "Unknown name" }}
                              <Badge v-if="contact.isDecisionMaker" variant="secondary" class="ml-1.5">decision maker</Badge>
                            </p>
                            <p v-if="contact.title" class="mt-0.5 text-xs text-muted-foreground">
                              {{ contact.title }}
                            </p>
                            <div
                              v-if="contact.email || contact.phone || contact.phoneNormalized || contact.whatsapp || contact.linkedinUrl"
                              class="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs"
                            >
                              <a v-if="contact.email" :href="`mailto:${contact.email}`" class="underline underline-offset-2 hover:text-foreground">
                                {{ contact.email }}
                                <span
                                  v-if="contact.emailVerification"
                                  class="ml-1 rounded px-1 py-0.5 text-[10px] font-medium"
                                  :class="
                                    contact.emailVerification === 'undeliverable' ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'
                                  "
                                >
                                  {{ contact.emailVerification }}
                                </span>
                              </a>
                              <span v-if="contact.phoneNormalized || contact.phone" class="tabular-nums text-muted-foreground">
                                {{ contact.phoneNormalized ?? contact.phone }}
                                <span v-if="contact.whatsapp" class="ml-1 rounded bg-success/10 px-1 py-0.5 text-[10px] font-medium text-success">WA</span>
                              </span>
                              <a
                                v-if="contact.linkedinUrl"
                                :href="contact.linkedinUrl"
                                target="_blank"
                                rel="noopener"
                                class="underline underline-offset-2 hover:text-foreground"
                                >LinkedIn</a
                              >
                            </div>
                            <p v-else class="mt-1 text-xs italic text-muted-foreground">
                              Named but no reachable channel yet — the enrich pass keeps looking for an email.
                            </p>
                          </div>
                        </div>
                      </div>
                      <div v-else>
                        <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Contacts</p>
                        <p class="mt-1.5 text-sm text-muted-foreground">No contacts found yet. The enrich pass keeps trying until one lands.</p>
                      </div>
                      <div>
                        <Button size="sm" variant="outline" :disabled="recrawlBusy === lead.id" @click.stop="recrawl(lead)">
                          <RefreshCw class="mr-1.5 size-3.5" :class="recrawlBusy === lead.id ? 'animate-spin' : ''" aria-hidden="true" />
                          {{ recrawlBusy === lead.id ? "Re-crawling…" : "Re-crawl contacts" }}
                        </Button>
                      </div>
                    </div>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </template>
    <Dialog v-model:open="settingsOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Campaign settings</DialogTitle>
          <DialogDescription>Applies to the next run.</DialogDescription>
        </DialogHeader>
        <div class="space-y-4 py-2">
          <div class="space-y-1.5">
            <Label for="goal-input">Daily prospect goal</Label>
            <Input id="goal-input" v-model.number="goalInput" type="number" min="1" max="10000" />
          </div>
          <div class="space-y-1.5">
            <Label for="interval-input">Schedule interval (hours)</Label>
            <Input id="interval-input" v-model.number="intervalInput" type="number" min="1" max="24" />
          </div>
          <div class="space-y-1.5">
            <Label for="exclusions-input">Exclusions (comma-separated)</Label>
            <Input id="exclusions-input" v-model="exclusionsInput" placeholder="warkop, kedai kopi" />
          </div>
          <div class="space-y-1.5">
            <Label for="notes-input">Notes for query planning</Label>
            <Textarea id="notes-input" v-model="notesInput" rows="2" placeholder="Prefer exporters with 20+ staff" />
          </div>
          <div class="space-y-1.5">
            <Label for="max-turns-input">Max turns per run</Label>
            <Input id="max-turns-input" v-model.number="maxTurnsInput" type="number" min="1" max="50" placeholder="unlimited" />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div class="space-y-1.5">
              <Label for="sheet-id-input">Spreadsheet ID for this campaign</Label>
              <Input id="sheet-id-input" v-model="sheetIdInput" placeholder="default export sheet" />
            </div>
            <div class="space-y-1.5">
              <Label for="sheet-name-input">Sheet tab</Label>
              <Input id="sheet-name-input" v-model="sheetNameInput" placeholder="first tab" />
            </div>
          </div>
          <div class="space-y-1.5">
            <Label for="export-mode-input">Export rows</Label>
            <select
              id="export-mode-input"
              v-model="exportModeInput"
              class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="one_per_company">One row per company (best email)</option>
              <option value="all_contacts">All contacts per company (up to 5)</option>
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" size="sm" @click="settingsOpen = false">Cancel</Button>
          <Button size="sm" :disabled="settingsBusy" @click="saveSettings">{{ settingsBusy ? "Saving…" : "Save" }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
