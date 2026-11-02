<script setup lang="ts">
import { toast } from "vue-sonner";

definePageMeta({ middleware: "auth" });

interface Campaign {
  id: string;
  name: string;
  niche: string;
  area: string | null;
  notes: string | null;
  exclusions: string[];
  status: string;
  dailyLeadGoal: number;
  scheduleEnabled: boolean;
  scheduleIntervalHours: number;
  totalLeads: number;
  readyLeads: number;
  lastRunAt: string | null;
}

const campaigns = ref<Campaign[]>([]);
const loading = ref(true);
const showCreate = ref(false);
const creating = ref(false);

const form = ref({
  name: "",
  niche: "",
  area: "",
  notes: "",
  exclusionsText: "",
  dailyLeadGoal: 100,
});

async function load() {
  loading.value = true;
  try {
    const res = await $fetch<{ campaigns: Campaign[] }>("/api/campaigns");
    campaigns.value = res.campaigns;
  } catch (err) {
    toast.error(friendlyError(err));
  } finally {
    loading.value = false;
  }
}

onMounted(load);

async function create() {
  if (!form.value.name.trim() || !form.value.niche.trim()) return;
  creating.value = true;
  try {
    const exclusions = form.value.exclusionsText
      .split(/[,\n]/)
      .map((t) => t.trim())
      .filter(Boolean);
    await $fetch("/api/campaigns", {
      method: "POST",
      body: {
        name: form.value.name.trim(),
        niche: form.value.niche.trim(),
        area: form.value.area.trim() || null,
        notes: form.value.notes.trim() || null,
        ...(exclusions.length > 0 ? { exclusions } : {}),
        dailyLeadGoal: form.value.dailyLeadGoal,
      },
    });
    showCreate.value = false;
    form.value = { name: "", niche: "", area: "", notes: "", exclusionsText: "", dailyLeadGoal: 100 };
    toast.success("Campaign created.");
    await load();
  } catch (err) {
    toast.error(friendlyError(err));
  } finally {
    creating.value = false;
  }
}

const totalReady = computed(() => campaigns.value.reduce((sum, c) => sum + c.readyLeads, 0));
const totalLeads = computed(() => campaigns.value.reduce((sum, c) => sum + c.totalLeads, 0));

function readyRate(campaign: Campaign) {
  if (campaign.totalLeads === 0) return 0;
  return Math.round((campaign.readyLeads / campaign.totalLeads) * 100);
}
</script>

<template>
  <div class="mx-auto flex h-full w-full max-w-7xl flex-col px-8 py-5">
    <div class="flex items-center justify-between pb-4">
      <div>
        <h1 class="text-lg font-bold tracking-tight">Campaigns</h1>
        <p class="text-sm text-muted-foreground">Find companies in a niche, harvest contacts, and ship prospect rows.</p>
      </div>
      <Button @click="showCreate = true">
        <Plus class="mr-2 size-4" aria-hidden="true" />
        New campaign
      </Button>
    </div>

    <div class="flex gap-3 pb-4">
      <div class="flex-1 rounded-xl border border-border bg-card p-4">
        <p class="text-xs font-medium uppercase tracking-widest text-muted-foreground">Prospect rows</p>
        <p class="mt-1 text-2xl font-bold">{{ totalReady }}</p>
      </div>
      <div class="flex-1 rounded-xl border border-border bg-card p-4">
        <p class="text-xs font-medium uppercase tracking-widest text-muted-foreground">Companies found</p>
        <p class="mt-1 text-2xl font-bold">{{ totalLeads }}</p>
      </div>
      <div class="flex-1 rounded-xl border border-border bg-card p-4">
        <p class="text-xs font-medium uppercase tracking-widest text-muted-foreground">Active campaigns</p>
        <p class="mt-1 text-2xl font-bold">{{ campaigns.filter((c) => c.status === "active").length }}</p>
      </div>
    </div>

    <div v-if="loading" class="flex-1 space-y-3">
      <Skeleton v-for="i in 3" :key="i" class="h-24 w-full" />
    </div>

    <div v-else-if="campaigns.length === 0" class="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <p class="text-lg font-semibold">No campaigns yet</p>
      <p class="max-w-sm text-sm text-muted-foreground">
        Describe who to hunt — e.g. "furniture factories in Jepara" — and Prospectus finds companies and their contacts.
      </p>
      <Button variant="outline" @click="showCreate = true">
        <Plus class="mr-2 size-4" aria-hidden="true" />
        Create your first campaign
      </Button>
    </div>

    <div v-else class="flex-1 space-y-3 overflow-y-auto pb-4">
      <NuxtLink
        v-for="campaign in campaigns"
        :key="campaign.id"
        :to="`/campaigns/${campaign.id}`"
        class="block rounded-xl border border-border bg-card p-5 transition-colors hover:border-ring"
      >
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <h2 class="truncate text-base font-semibold">{{ campaign.name }}</h2>
              <span
                class="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
                :class="campaign.status === 'active' ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground'"
              >
                {{ campaign.status }}
              </span>
            </div>
            <p class="mt-0.5 truncate text-xs text-muted-foreground">
              {{ campaign.niche }}<template v-if="campaign.area"> · {{ campaign.area }}</template>
            </p>
            <div v-if="campaign.exclusions.length > 0" class="mt-2 flex flex-wrap gap-1">
              <span
                v-for="term in campaign.exclusions.slice(0, 4)"
                :key="term"
                class="rounded bg-destructive/10 px-1.5 py-0.5 text-[10px] font-medium text-destructive"
              >
                ×{{ term }}
              </span>
              <span v-if="campaign.exclusions.length > 4" class="text-[10px] text-muted-foreground">+{{ campaign.exclusions.length - 4 }} more</span>
            </div>
          </div>
          <div class="flex shrink-0 gap-6 text-right">
            <div>
              <p class="text-xs text-muted-foreground">Ready</p>
              <p class="text-lg font-bold">{{ campaign.readyLeads }}</p>
            </div>
            <div>
              <p class="text-xs text-muted-foreground">Found</p>
              <p class="text-lg font-bold">{{ campaign.totalLeads }}</p>
            </div>
            <div>
              <p class="text-xs text-muted-foreground">Ready rate</p>
              <p class="text-lg font-bold">{{ readyRate(campaign) }}%</p>
            </div>
            <div>
              <p class="text-xs text-muted-foreground">Last run</p>
              <p class="text-sm font-medium">{{ campaign.lastRunAt ? formatDateTime(campaign.lastRunAt) : "never" }}</p>
            </div>
          </div>
        </div>
      </NuxtLink>
    </div>

    <Dialog v-model:open="showCreate">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New campaign</DialogTitle>
          <DialogDescription>What businesses should Prospectus hunt? Contacts are gathered automatically.</DialogDescription>
        </DialogHeader>
        <div class="space-y-4">
          <div class="space-y-2">
            <Label for="c-name">Campaign name</Label>
            <Input id="c-name" v-model="form.name" placeholder="Jepara furniture hunt" />
          </div>
          <div class="space-y-2">
            <Label for="c-niche">Niche — what businesses to find</Label>
            <Input id="c-niche" v-model="form.niche" placeholder="pabrik furniture" />
          </div>
          <div class="space-y-2">
            <Label for="c-area">Area</Label>
            <Input id="c-area" v-model="form.area" placeholder="Jepara" />
          </div>
          <div class="space-y-2">
            <Label for="c-exclusions">Exclusions — never include these</Label>
            <Input id="c-exclusions" v-model="form.exclusionsText" placeholder="warkop, kedai kopi, distributor" />
            <p class="text-xs text-muted-foreground">Comma-separated. Matching companies are dropped before any crawling.</p>
          </div>
          <div class="space-y-2">
            <Label for="c-notes">Notes for query planning (optional)</Label>
            <Textarea id="c-notes" v-model="form.notes" rows="2" placeholder="Prefer exporters with 20+ staff" />
          </div>
          <div class="space-y-2">
            <Label for="c-goal">Daily prospect goal</Label>
            <Input id="c-goal" v-model.number="form.dailyLeadGoal" type="number" min="1" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="showCreate = false">Cancel</Button>
          <Button :disabled="creating || !form.name.trim() || !form.niche.trim()" @click="create">
            {{ creating ? "Creating…" : "Create campaign" }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
