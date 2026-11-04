<script setup lang="ts">
import { toast } from "vue-sonner";
import { Download, Inbox, Loader2, Mail, Plus, Search } from "lucide-vue-next";
import Badge from "~/components/ui/badge/Badge.vue";
import Button from "~/components/ui/button/Button.vue";
import Input from "~/components/ui/input/Input.vue";
import Label from "~/components/ui/label/Label.vue";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { formatClock } from "~/utils/datetime";
import { friendlyError } from "~/utils/errors";

definePageMeta({ middleware: "auth" });

interface BestContact {
  name: string | null;
  title: string | null;
  email: string | null;
  emailVerification: string | null;
  phone: string | null;
  whatsapp: string | null;
}

interface CompanyRow {
  id: string;
  name: string;
  website: string | null;
  phone: string | null;
  city: string | null;
  industry: string | null;
  status: string;
  hasEmail: boolean;
  validationNotes: string[];
  createdAt: string;
  contactCount: number;
  emailCount: number;
  bestContact: BestContact | null;
}

interface Stats {
  total: number;
  withEmail: number;
  needsReview: number;
  rejected: number;
}

interface DetailContact {
  id: string;
  name: string | null;
  title: string | null;
  email: string | null;
  emailType: string | null;
  emailVerification: string | null;
  phone: string | null;
  phoneNormalized: string | null;
  whatsapp: string | null;
  waLikely: boolean | null;
  linkedinUrl: string | null;
  isDecisionMaker: boolean | null;
  createdAt: string;
}

interface DetailCompany {
  id: string;
  name: string;
  legalEntity: string | null;
  website: string | null;
  linkedinUrl: string | null;
  emailDomain: string | null;
  address: string | null;
  city: string | null;
  province: string | null;
  country: string;
  phone: string | null;
  industry: string | null;
  productsServices: string[] | null;
  rating: number | null;
  reviewCount: number | null;
  branchesCount: number | null;
  digitalPresence: { hasWebsite: boolean; socials: string[]; waBusiness: boolean } | null;
  emailHuntAttempts: number;
  status: string;
  hasEmail: boolean;
  validationNotes: string[];
  createdAt: string;
  updatedAt: string;
}

interface CompanyDetail {
  company: DetailCompany;
  contacts: DetailContact[];
  provenanceSummary: Array<{ field: string; stage: string | null }>;
}

const companies = ref<CompanyRow[]>([]);
const stats = ref<Stats | null>(null);
const loading = ref(true);
const loadingMore = ref(false);
const nextCursor = ref<string | null>(null);
const exporting = ref(false);

const searchInput = ref("");
const cityInput = ref("");
const industryInput = ref("");
const statusFilter = ref("all");
const reachableOnly = ref(false);

const detailOpen = ref(false);
const detailLoading = ref(false);
const detail = ref<CompanyDetail | null>(null);

interface IngestAdapter {
  id: string;
  label: string;
}

interface IngestJobRow {
  id: string;
  source: string;
  status: string;
  rowsSeen: number;
  newCompanies: number;
  error: string | null;
  finishedAt: string | null;
  createdAt: string;
}

interface IngestRunResultShape {
  jobId: string;
  pages: number;
  rows: number;
  withEmail: number;
  newCompanies: number;
  newLeads: number;
  duplicates: number;
  rejected: number;
  flagged: number;
  stoppedReason: string;
}

interface HuntJobShape {
  id: string;
  status: string;
  requestedCount: number;
  processedCount: number;
  emailsFound: number;
  error: string | null;
  finishedAt: string | null;
}

interface CampaignOption {
  id: string;
  name: string;
  niche: string;
}

const selectedIds = ref<Set<string>>(new Set());
const showImportDialog = ref(false);
const importCampaigns = ref<CampaignOption[]>([]);
const importCampaignId = ref("");
const importHunt = ref(true);
const importing = ref(false);
const hunting = ref(false);
const importSearch = ref("");
const importLookup = ref<Array<{ id: string; name: string; city: string | null }>>([]);
const importLookupLoading = ref(false);
const huntProgress = ref<{ processed: number; requested: number; emailsFound: number } | null>(null);

const ingestOpen = ref(false);
const ingestAdapters = ref<IngestAdapter[]>([]);
const ingestAdapterId = ref("");
const ingestPages = ref(20);
const ingestRunning = ref(false);
const ingestJobs = ref<IngestJobRow[]>([]);
const ingestResult = ref<IngestRunResultShape | null>(null);

let huntPollTimer: ReturnType<typeof setInterval> | null = null;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function buildParams(cursor?: string) {
  const params = new URLSearchParams();
  if (searchInput.value.trim()) params.set("q", searchInput.value.trim());
  if (cityInput.value.trim()) params.set("city", cityInput.value.trim());
  if (industryInput.value.trim()) params.set("industry", industryInput.value.trim());
  if (statusFilter.value !== "all") params.set("status", statusFilter.value);
  if (reachableOnly.value) params.set("reachable", "email");
  if (cursor) params.set("cursor", cursor);
  return params;
}

async function load() {
  loading.value = true;
  try {
    const res = await $fetch<{ companies: CompanyRow[]; nextCursor: string | null }>(`/api/master/companies?${buildParams().toString()}`);
    companies.value = res.companies;
    nextCursor.value = res.nextCursor;
  } catch (err) {
    toast.error(friendlyError(err));
  } finally {
    loading.value = false;
  }
}

async function loadMore() {
  if (!nextCursor.value || loadingMore.value) return;
  loadingMore.value = true;
  try {
    const res = await $fetch<{ companies: CompanyRow[]; nextCursor: string | null }>(`/api/master/companies?${buildParams(nextCursor.value).toString()}`);
    companies.value = [...companies.value, ...res.companies];
    nextCursor.value = res.nextCursor;
  } catch (err) {
    toast.error(friendlyError(err));
  } finally {
    loadingMore.value = false;
  }
}

function debounceReload() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(load, 300);
}

async function loadStats() {
  try {
    stats.value = await $fetch<Stats>("/api/master/stats");
  } catch (err) {
    toast.error(friendlyError(err));
  }
}

async function openDetail(row: CompanyRow) {
  detailOpen.value = true;
  detailLoading.value = true;
  detail.value = null;
  try {
    detail.value = await $fetch<CompanyDetail>(`/api/master/companies/${row.id}`);
  } catch (err) {
    toast.error(friendlyError(err));
    detailOpen.value = false;
  } finally {
    detailLoading.value = false;
  }
}

async function exportCsv() {
  exporting.value = true;
  try {
    const qs = buildParams().toString();
    window.location.href = `/api/master/companies.csv${qs ? `?${qs}` : ""}`;
  } finally {
    setTimeout(() => {
      exporting.value = false;
    }, 1000);
  }
}

const statusBadgeClass: Record<string, string> = {
  valid: "",
  needs_review: "bg-warning/15 text-warning border border-warning/30",
  rejected: "bg-destructive/15 text-destructive border border-destructive/30",
};

const emailBadgeClass = "bg-success/15 text-success border border-success/30 font-medium";

const selectedCount = computed(() => selectedIds.value.size);

function toggleSelect(id: string) {
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
}

const allPageSelected = computed(() => companies.value.length > 0 && companies.value.every((c) => selectedIds.value.has(c.id)));

function toggleSelectAll() {
  if (allPageSelected.value) {
    selectedIds.value = new Set();
    return;
  }
  selectedIds.value = new Set(companies.value.map((c) => c.id));
}

function clearSelection() {
  selectedIds.value = new Set();
}

async function searchCampaignCompanies() {
  const q = importSearch.value.trim();
  if (q.length < 2) {
    importLookup.value = [];
    return;
  }
  importLookupLoading.value = true;
  try {
    const res = await $fetch<{ companies: Array<{ id: string; name: string; city: string | null }> }>(`/api/campaigns/lookup?q=${encodeURIComponent(q)}`);
    importLookup.value = res.companies;
  } catch (err) {
    toast.error(friendlyError(err));
  } finally {
    importLookupLoading.value = false;
  }
}

let importLookupTimer: ReturnType<typeof setTimeout> | null = null;

function onImportSearchInput() {
  if (importLookupTimer) clearTimeout(importLookupTimer);
  importLookupTimer = setTimeout(searchCampaignCompanies, 250);
}

function pickLookupCompany(company: { id: string; name: string }) {
  const next = new Set(selectedIds.value);
  next.add(company.id);
  selectedIds.value = next;
  importSearch.value = "";
  importLookup.value = [];
  toast.info(`${company.name} added to selection.`);
}

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(diff)) return "";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function startHuntPoll(jobId: string) {
  if (huntPollTimer) clearInterval(huntPollTimer);
  const startedAt = Date.now();
  huntProgress.value = { processed: 0, requested: 0, emailsFound: 0 };
  huntPollTimer = setInterval(async () => {
    try {
      const res = await $fetch<{ job: HuntJobShape }>(`/api/hunt/jobs/${jobId}`);
      const job = res.job;
      huntProgress.value = { processed: job.processedCount, requested: job.requestedCount, emailsFound: job.emailsFound };
      if (job.finishedAt) {
        if (huntPollTimer) clearInterval(huntPollTimer);
        huntPollTimer = null;
        huntProgress.value = null;
        if (job.status === "failed") toast.error(`Email hunt failed: ${job.error ?? "unknown error"}`);
        else toast.success(`Email hunt finished: found ${job.emailsFound} emails across ${job.processedCount} companies.`);
        await Promise.all([load(), loadStats()]);
      } else if (Date.now() - startedAt > 600_000) {
        if (huntPollTimer) clearInterval(huntPollTimer);
        huntPollTimer = null;
        huntProgress.value = null;
        toast.error("Email hunt is taking too long. Results will appear on the next refresh.");
      }
    } catch (err) {
      if (huntPollTimer) clearInterval(huntPollTimer);
      huntPollTimer = null;
      huntProgress.value = null;
      toast.error(friendlyError(err));
    }
  }, 3000);
}

async function runEmailHunt() {
  if (selectedIds.value.size === 0) return;
  hunting.value = true;
  try {
    const res = await $fetch<{ jobId: string; requestedCount: number }>("/api/hunt/jobs", {
      method: "POST",
      body: { companyIds: [...selectedIds.value], onlyNoEmail: true },
    });
    toast.info(`Email hunt started for ${res.requestedCount} companies. We'll notify you when it completes.`);
    startHuntPoll(res.jobId);
  } catch (err) {
    toast.error(friendlyError(err));
  } finally {
    hunting.value = false;
  }
}

async function openImportDialog() {
  showImportDialog.value = true;
  importSearch.value = "";
  importLookup.value = [];
  try {
    const res = await $fetch<{ campaigns: Array<{ id: string; name: string; niche: string }> }>("/api/campaigns");
    importCampaigns.value = res.campaigns.map((c) => ({ id: c.id, name: c.name, niche: c.niche }));
    if (!importCampaignId.value && importCampaigns.value[0]) importCampaignId.value = importCampaigns.value[0].id;
  } catch (err) {
    toast.error(friendlyError(err));
  }
}

async function submitImport() {
  if (!importCampaignId.value || selectedIds.value.size === 0) return;
  importing.value = true;
  try {
    const res = await $fetch<{ imported: number; duplicates: number; huntJobId?: string }>("/api/campaigns/import", {
      method: "POST",
      body: { campaignId: importCampaignId.value, companyIds: [...selectedIds.value], hunt: importHunt.value },
    });
    toast.success(`Imported ${res.imported} companies (${res.duplicates} duplicates skipped).`);
    if (res.huntJobId) {
      toast.info("Email hunt started for rows without an email.");
      startHuntPoll(res.huntJobId);
    }
    showImportDialog.value = false;
    clearSelection();
    await Promise.all([load(), loadStats()]);
  } catch (err) {
    toast.error(friendlyError(err));
  } finally {
    importing.value = false;
  }
}

async function loadIngestPanel() {
  try {
    const res = await $fetch<{
      adapters: IngestAdapter[];
      jobs: Array<{
        id: string;
        source: string;
        status: string;
        rowsSeen: number;
        newCompanies: number;
        error: string | null;
        finishedAt: string | null;
        createdAt: string;
      }>;
    }>("/api/ingest");
    ingestAdapters.value = res.adapters;
    ingestJobs.value = res.jobs.slice(0, 5);
    if (!ingestAdapterId.value && res.adapters[0]) ingestAdapterId.value = res.adapters[0].id;
  } catch (err) {
    toast.error(friendlyError(err));
  }
}

async function runIngest() {
  if (!ingestAdapterId.value) return;
  ingestRunning.value = true;
  try {
    const res = await $fetch<IngestRunResultShape>("/api/ingest/run", {
      method: "POST",
      body: { adapterId: ingestAdapterId.value, pages: Math.min(Math.max(ingestPages.value, 1), 500) },
    });
    toast.success(
      `Ingest done: ${res.rows} rows, ${res.newCompanies} new companies, ${res.withEmail} with email, ${res.rejected} rejected, ${res.flagged} flagged.`,
    );
    ingestResult.value = res;
    await Promise.all([loadIngestPanel(), loadStats(), load()]);
  } catch (err) {
    toast.error(friendlyError(err));
  } finally {
    ingestRunning.value = false;
  }
}

onMounted(() => {
  load();
  loadStats();
  ingestOpen.value = true;
  loadIngestPanel();
});

onUnmounted(() => {
  if (huntPollTimer) clearInterval(huntPollTimer);
});
</script>

<template>
  <div class="flex h-full flex-col overflow-hidden">
    <header class="border-b border-border px-8 py-5">
      <div class="flex items-center justify-between gap-4">
        <div>
          <h1 class="text-xl font-bold tracking-tight">Master Data</h1>
          <p class="text-sm text-muted-foreground">Global companies and contacts across all campaigns</p>
        </div>
        <Button variant="outline" size="sm" :disabled="exporting" @click="exportCsv">
          <Download class="size-4" aria-hidden="true" />
          {{ exporting ? "Exporting…" : "Export CSV" }}
        </Button>
      </div>
      <div v-if="stats" class="mt-3 flex flex-wrap gap-2">
        <Badge variant="secondary">{{ stats.total }} companies</Badge>
        <Badge variant="default">{{ stats.withEmail }} with email</Badge>
        <Badge variant="secondary">{{ stats.needsReview }} needs review</Badge>
        <Badge v-if="stats.rejected > 0" variant="destructive">{{ stats.rejected }} rejected</Badge>
      </div>
      <div v-if="huntProgress" class="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 class="size-4 animate-spin" aria-hidden="true" />
        <span> Hunt in progress: {{ huntProgress.processed }}/{{ huntProgress.requested }} processed, {{ huntProgress.emailsFound }} emails found </span>
      </div>
    </header>

    <div class="border-b border-border px-8 py-4">
      <div class="flex flex-wrap items-center gap-3">
        <div class="relative min-w-56 flex-1">
          <Search class="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input v-model="searchInput" placeholder="Search company name" class="pl-8" @input="debounceReload" />
        </div>
        <select
          v-model="statusFilter"
          class="h-9 w-40 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          @change="load"
        >
          <option value="all">All statuses</option>
          <option value="valid">Valid</option>
          <option value="needs_review">Needs review</option>
          <option value="rejected">Rejected</option>
        </select>
        <label class="flex items-center gap-2 text-sm font-medium">
          <input v-model="reachableOnly" type="checkbox" class="size-4 rounded border-input" @change="load" />
          Has email
        </label>
        <Input v-model="cityInput" placeholder="City (exact)" class="w-40" @input="debounceReload" />
        <Input v-model="industryInput" placeholder="Industry (exact)" class="w-44" @input="debounceReload" />
      </div>
    </div>

    <div class="border-b border-border px-8 py-3">
      <button type="button" class="flex items-center gap-2 text-sm font-semibold" @click="ingestOpen = !ingestOpen">
        <Inbox class="size-4" aria-hidden="true" />
        Ingest
        <span class="text-muted-foreground">{{ ingestOpen ? "hide" : "show" }}</span>
      </button>
      <div v-if="ingestOpen" class="mt-3 space-y-3">
        <div class="flex flex-wrap items-center gap-3">
          <select
            v-model="ingestAdapterId"
            class="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option v-for="adapter in ingestAdapters" :key="adapter.id" :value="adapter.id">{{ adapter.label }}</option>
          </select>
          <label class="flex items-center gap-2 text-sm font-medium">
            Pages
            <input
              v-model.number="ingestPages"
              type="number"
              min="1"
              max="500"
              class="h-9 w-20 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </label>
          <Button size="sm" :disabled="ingestRunning || !ingestAdapterId" @click="runIngest">
            <Loader2 v-if="ingestRunning" class="mr-2 size-4 animate-spin" aria-hidden="true" />
            {{ ingestRunning ? "Running…" : "Run ingest" }}
          </Button>
        </div>
        <div v-if="ingestRunning" class="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 class="size-4 animate-spin" aria-hidden="true" />
          <span>Crawling directory pages… this can take a few minutes.</span>
        </div>
        <div v-else-if="ingestResult" class="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
          <span class="font-medium">Last run:</span> {{ ingestResult.rows }} rows, {{ ingestResult.withEmail }} with email, {{ ingestResult.newCompanies }} new
          companies, {{ ingestResult.newLeads }} new leads, {{ ingestResult.duplicates }} duplicates, {{ ingestResult.rejected }} rejected,
          {{ ingestResult.flagged }} flagged
          <span v-if="ingestResult.stoppedReason" class="text-muted-foreground">({{ ingestResult.stoppedReason }})</span>
        </div>
        <div v-if="ingestJobs.length > 0">
          <p class="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recent ingest jobs</p>
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th class="py-1.5 pr-4 font-semibold">Status</th>
                <th class="py-1.5 pr-4 font-semibold">Source</th>
                <th class="py-1.5 pr-4 font-semibold">Rows seen</th>
                <th class="py-1.5 pr-4 font-semibold">New companies</th>
                <th class="py-1.5 font-semibold">Finished</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="job in ingestJobs" :key="job.id" class="border-b border-border/60">
                <td class="py-1.5 pr-4">
                  <span :title="job.status === 'failed' ? (job.error ?? 'Unknown error') : undefined">
                    <Badge :variant="job.status === 'failed' ? 'destructive' : job.status === 'succeeded' ? 'secondary' : 'default'">{{ job.status }}</Badge>
                  </span>
                </td>
                <td class="py-1.5 pr-4">{{ job.source }}</td>
                <td class="py-1.5 pr-4 tabular-nums">{{ job.rowsSeen }}</td>
                <td class="py-1.5 pr-4 tabular-nums">{{ job.newCompanies }}</td>
                <td class="py-1.5 text-muted-foreground">{{ relativeTime(job.finishedAt ?? job.createdAt) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="flex-1 overflow-auto px-8 py-4">
      <div v-if="loading" class="space-y-2">
        <div v-for="i in 6" :key="i" class="h-12 animate-pulse rounded-md bg-muted" />
      </div>

      <div v-else-if="companies.length === 0" class="py-16 text-center text-sm text-muted-foreground">No companies match the current filters.</div>

      <template v-else>
        <div
          v-if="selectedCount > 0"
          class="sticky bottom-0 z-10 -mx-2 mb-3 flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-2.5 shadow-md"
        >
          <span class="text-sm font-medium">{{ selectedCount }} selected</span>
          <Button size="sm" :disabled="hunting" @click="runEmailHunt">
            <Loader2 v-if="hunting" class="mr-2 size-4 animate-spin" aria-hidden="true" />
            <Mail v-else class="mr-2 size-4" aria-hidden="true" />
            Email hunt
          </Button>
          <Button size="sm" variant="outline" @click="openImportDialog">
            <Plus class="mr-2 size-4" aria-hidden="true" />
            Add to campaign…
          </Button>
          <Button size="sm" variant="ghost" class="ml-auto" @click="clearSelection">Clear</Button>
        </div>
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th class="px-4 py-3">
                <input type="checkbox" class="size-4 rounded border-input" :checked="allPageSelected" @change="toggleSelectAll" @click.stop />
              </th>
              <th class="px-4 py-3 font-semibold">Name</th>
              <th class="px-4 py-3 font-semibold">Website</th>
              <th class="px-4 py-3 font-semibold">City</th>
              <th class="px-4 py-3 font-semibold">Industry</th>
              <th class="px-4 py-3 font-semibold">Status</th>
              <th class="px-4 py-3 font-semibold">Email</th>
              <th class="px-4 py-3 font-semibold">Best contact</th>
              <th class="px-4 py-3 font-semibold">Contacts</th>
              <th class="px-4 py-3 font-semibold">Created</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in companies"
              :key="row.id"
              class="cursor-pointer border-b border-border/60 transition-colors hover:bg-muted/30"
              @click="openDetail(row)"
            >
              <td class="px-4 py-3 align-middle">
                <input type="checkbox" class="size-4 rounded border-input" :checked="selectedIds.has(row.id)" @change="toggleSelect(row.id)" @click.stop />
              </td>
              <td class="px-4 py-3 align-middle font-semibold">{{ row.name }}</td>
              <td class="max-w-48 truncate px-4 py-3 align-middle">
                <a v-if="row.website" :href="row.website" target="_blank" rel="noopener" class="text-primary hover:underline" @click.stop>{{ row.website }}</a>
              </td>
              <td class="px-4 py-3 align-middle">{{ row.city }}</td>
              <td class="line-clamp-2 max-w-56 px-4 py-3 align-middle">{{ row.industry }}</td>
              <td class="px-4 py-3 align-middle">
                <Badge :class="statusBadgeClass[row.status]" :variant="row.status === 'valid' ? 'outline' : 'default'">{{ row.status }}</Badge>
              </td>
              <td class="px-4 py-3 align-middle">
                <Badge v-if="row.hasEmail" :class="emailBadgeClass">email</Badge>
                <Badge v-else variant="outline" class="text-muted-foreground">no email</Badge>
              </td>
              <td class="px-4 py-3 align-middle">
                <div class="flex flex-col">
                  <span v-if="row.bestContact?.email" class="truncate">{{ row.bestContact.email }}</span>
                  <span v-if="row.bestContact?.phone" class="text-muted-foreground">{{ row.bestContact.phone }}</span>
                </div>
              </td>
              <td class="px-4 py-3 align-middle tabular-nums">{{ row.contactCount }}</td>
              <td class="px-4 py-3 align-middle text-muted-foreground">{{ formatClock(row.createdAt) }}</td>
            </tr>
          </tbody>
        </table>

        <div v-if="nextCursor" class="mt-4 flex justify-center">
          <Button variant="outline" size="sm" :disabled="loadingMore" @click="loadMore">
            {{ loadingMore ? "Loading…" : "Load more" }}
          </Button>
        </div>
      </template>
    </div>

    <Dialog v-model:open="detailOpen">
      <DialogContent class="max-h-[85vh] max-w-3xl overflow-auto p-6">
        <template v-if="detail">
          <DialogHeader class="pr-8">
            <DialogTitle class="truncate" :title="detail.company.name">{{ detail.company.name }}</DialogTitle>
            <DialogDescription class="truncate">
              {{ detail.company.city ?? "" }}{{ detail.company.city && detail.company.industry ? " · " : "" }}{{ detail.company.industry ?? "" }}
            </DialogDescription>
          </DialogHeader>

          <div class="grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            <div v-if="detail.company.website" class="min-w-0">
              <dt class="text-xs uppercase tracking-wide text-muted-foreground">Website</dt>
              <dd class="mt-0.5 truncate">
                <a :href="detail.company.website" target="_blank" rel="noopener" class="text-primary hover:underline">{{ detail.company.website }}</a>
              </dd>
            </div>
            <div v-if="detail.company.phone">
              <dt class="text-xs uppercase tracking-wide text-muted-foreground">Phone</dt>
              <dd class="mt-0.5">{{ detail.company.phone }}</dd>
            </div>
            <div>
              <dt class="text-xs uppercase tracking-wide text-muted-foreground">Status</dt>
              <dd class="mt-0.5">
                <Badge :class="statusBadgeClass[detail.company.status]" :variant="detail.company.status === 'valid' ? 'outline' : 'default'">
                  {{ detail.company.status }}
                </Badge>
              </dd>
            </div>
            <div>
              <dt class="text-xs uppercase tracking-wide text-muted-foreground">Has email</dt>
              <dd class="mt-0.5">
                <Badge v-if="detail.company.hasEmail" :class="emailBadgeClass">yes</Badge>
                <Badge v-else variant="outline" class="text-muted-foreground">no</Badge>
              </dd>
            </div>
            <div v-if="detail.company.address" class="min-w-0">
              <dt class="text-xs uppercase tracking-wide text-muted-foreground">Address</dt>
              <dd class="mt-0.5">{{ detail.company.address }}</dd>
            </div>
            <div>
              <dt class="text-xs uppercase tracking-wide text-muted-foreground">Country</dt>
              <dd class="mt-0.5">{{ detail.company.country }}</dd>
            </div>
          </div>

          <div>
            <p class="mb-2 font-semibold text-sm">Contacts ({{ detail.contacts.length }})</p>
            <div v-if="detail.contacts.length === 0" class="text-sm text-muted-foreground">No contacts recorded.</div>
            <div v-else class="overflow-x-auto rounded-md border border-border/60">
              <table class="w-full min-w-3xl text-sm">
                <thead>
                  <tr class="border-b border-border bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th class="px-3 py-2 font-semibold">Name</th>
                    <th class="px-3 py-2 font-semibold">Title</th>
                    <th class="px-3 py-2 font-semibold">Email</th>
                    <th class="px-3 py-2 font-semibold">Type</th>
                    <th class="px-3 py-2 font-semibold">Verification</th>
                    <th class="px-3 py-2 font-semibold">Phone</th>
                    <th class="px-3 py-2 font-semibold">WhatsApp</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="c in detail.contacts" :key="c.id" class="border-b border-border/60 last:border-b-0">
                    <td class="px-3 py-2 align-middle font-medium">
                      {{ c.name }}<Badge v-if="c.isDecisionMaker" variant="secondary" class="ml-1.5">DM</Badge>
                    </td>
                    <td class="px-3 py-2 align-middle">{{ c.title }}</td>
                    <td class="max-w-48 truncate px-3 py-2 align-middle" :title="c.email ?? undefined">{{ c.email }}</td>
                    <td class="px-3 py-2 align-middle">{{ c.emailType }}</td>
                    <td class="px-3 py-2 align-middle">{{ c.emailVerification }}</td>
                    <td class="px-3 py-2 align-middle">{{ c.phoneNormalized ?? c.phone }}</td>
                    <td class="px-3 py-2 align-middle">{{ c.whatsapp }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <p v-if="detail.provenanceSummary.length > 0" class="border-t border-border/60 pt-3 text-xs text-muted-foreground">
            Sources:
            {{ detail.provenanceSummary.map((p) => (p.stage ? `${p.field} (${p.stage})` : p.field)).join(", ") }}
          </p>
        </template>
        <div v-else class="space-y-2">
          <div v-for="i in 4" :key="i" class="h-6 animate-pulse rounded bg-muted" />
        </div>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="showImportDialog">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add to campaign</DialogTitle>
          <DialogDescription>Add {{ selectedCount }} selected companies to a campaign. Duplicates are skipped.</DialogDescription>
        </DialogHeader>
        <div class="space-y-4">
          <div class="space-y-2">
            <Label for="import-campaign">Campaign</Label>
            <select
              id="import-campaign"
              v-model="importCampaignId"
              class="h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option v-for="c in importCampaigns" :key="c.id" :value="c.id">{{ c.name }} — {{ c.niche }}</option>
            </select>
          </div>
          <div class="space-y-2">
            <Label for="import-lookup">Find company</Label>
            <div class="relative">
              <Search class="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <Input id="import-lookup" v-model="importSearch" placeholder="Search companies (min 2 chars)" class="pl-8" @input="onImportSearchInput" />
            </div>
            <div v-if="importLookupLoading" class="text-xs text-muted-foreground">Searching…</div>
            <div v-else-if="importLookup.length > 0" class="max-h-40 overflow-auto rounded-md border border-border">
              <button
                v-for="c in importLookup"
                :key="c.id"
                type="button"
                class="flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-muted/50"
                @click="pickLookupCompany(c)"
              >
                <span class="truncate">{{ c.name }}</span>
                <span class="shrink-0 text-xs text-muted-foreground">{{ c.city }}</span>
              </button>
            </div>
          </div>
          <label class="flex items-center gap-2 text-sm font-medium">
            <input v-model="importHunt" type="checkbox" class="size-4 rounded border-input" />
            Also hunt emails for rows without one
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="showImportDialog = false">Cancel</Button>
          <Button :disabled="importing || !importCampaignId" @click="submitImport">
            <Loader2 v-if="importing" class="mr-2 size-4 animate-spin" aria-hidden="true" />
            {{ importing ? "Importing…" : "Import" }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
