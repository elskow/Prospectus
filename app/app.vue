<script setup lang="ts">
import { Toaster, toast } from "vue-sonner";
import { BarChart3, Database, LogOut, Settings, Users } from "lucide-vue-next";
import "vue-sonner/style.css";

const route = useRoute();
const { user, fetchMe, logout } = useAuth();

async function signOut() {
  try {
    await logout();
  } catch (err) {
    toast.error(friendlyError(err));
  }
}

useHead({
  htmlAttrs: { lang: "en" },
});

onMounted(async () => {
  await fetchMe();
});

const nav = [
  { to: "/campaigns", label: "Campaigns", icon: "campaigns" },
  { to: "/master", label: "Master", icon: "master" },
  { to: "/settings", label: "Settings", icon: "settings" },
  { to: "/users", label: "Users", icon: "users" },
];

function isActive(to: string) {
  return to === "/" ? route.path === "/" : route.path === to || route.path.startsWith(`${to}/`);
}

const initials = computed(() => {
  const source = user.value?.name ?? user.value?.email ?? "?";
  return source.slice(0, 2).toUpperCase();
});
</script>

<template>
  <div v-if="user && route.path !== '/onboarding'" class="flex h-screen overflow-hidden bg-background text-foreground">
    <a
      href="#main-content"
      class="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm"
    >
      Skip to content
    </a>

    <aside class="flex w-64 shrink-0 flex-col border-border bg-sidebar">
      <div class="flex h-16 items-center gap-2.5 border-b border-border px-6">
        <img src="~/assets/brand/prospectus-icon.svg" alt="Prospectus logo" class="size-7 rounded-md" />
        <span class="text-[15px] font-bold tracking-tight">Prospectus</span>
      </div>

      <p class="px-6 pt-6 pb-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Workspace</p>
      <nav class="space-y-1 px-3" aria-label="Main">
        <NuxtLink
          v-for="item in nav"
          :key="item.to"
          :to="item.to"
          :class="[
            'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
            isActive(item.to)
              ? 'bg-sidebar-accent font-semibold text-foreground'
              : 'font-medium text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
          ]"
          :aria-current="isActive(item.to) ? 'page' : undefined"
        >
          <BarChart3 v-if="item.icon === 'campaigns'" class="size-4" aria-hidden="true" />
          <Database v-else-if="item.icon === 'master'" class="size-4" aria-hidden="true" />
          <Settings v-else-if="item.icon === 'settings'" class="size-4" aria-hidden="true" />
          <Users v-else class="size-4" aria-hidden="true" />
          {{ item.label }}
        </NuxtLink>
      </nav>

      <div class="mt-auto border-t border-border p-3">
        <div class="flex items-center gap-3 rounded-lg px-3 py-2">
          <span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-warning/20 text-xs font-bold text-warning">
            {{ initials }}
          </span>
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-semibold">{{ user.name ?? user.email }}</p>
            <p v-if="user.name" class="truncate text-xs text-muted-foreground">{{ user.email }}</p>
          </div>
          <button
            type="button"
            class="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            aria-label="Sign out"
            @click="signOut"
          >
            <LogOut class="size-4" aria-hidden="true" />
          </button>
        </div>
        <div class="mt-1 flex gap-1 px-1 pb-1">
          <NuxtLink
            to="/profile"
            class="flex-1 rounded-md px-2 py-1.5 text-center text-xs font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
          >
            Profile
          </NuxtLink>
          <NuxtLink
            to="/settings"
            class="flex-1 rounded-md px-2 py-1.5 text-center text-xs font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
          >
            Platform
          </NuxtLink>
        </div>
      </div>
    </aside>

    <main id="main-content" class="min-w-0 flex-1 p-3 pl-0">
      <div class="flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <NuxtPage />
      </div>
    </main>
  </div>

  <template v-else>
    <NuxtPage />
  </template>

  <Toaster position="top-right" :duration="5000" close-button />
</template>

<style>
.vue-sonner-toast {
  font-family: inherit;
  border-radius: 0.75rem;
}
</style>
