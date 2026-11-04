<script setup lang="ts">
import { ArrowRight } from "lucide-vue-next";

definePageMeta({ middleware: "guest" });

useHead({ title: "Sign in · Prospectus" });

const { login } = useAuth();

const email = ref("");
const password = ref("");
const error = ref<string | null>(null);
const pending = ref(false);

async function submit() {
  error.value = null;
  pending.value = true;
  try {
    await login(email.value, password.value);
    await navigateTo("/settings");
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <div class="flex h-screen bg-background text-foreground">
    <main class="flex w-full flex-col px-8 py-8 md:w-[440px] md:shrink-0 md:px-14">
      <NuxtLink to="/" class="flex items-center gap-2.5" aria-label="Prospectus home">
        <img src="~/assets/brand/prospectus-icon.svg" alt="Prospectus logo" class="size-7 rounded-md" />
        <span class="text-[15px] font-bold tracking-tight">Prospectus</span>
      </NuxtLink>

      <div class="flex flex-1 flex-col justify-center pb-16">
        <h1 class="text-center text-xl font-bold tracking-tight">Welcome back</h1>
        <p class="mt-1.5 text-center text-sm text-muted-foreground">Sign in to your lead generation workspace</p>

        <form class="mt-8 space-y-3" aria-label="Sign in form">
          <div class="space-y-1.5">
            <Label for="email">Email</Label>
            <Input id="email" v-model="email" type="email" required autocomplete="email" placeholder="you@example.com" />
          </div>
          <div class="space-y-1.5">
            <Label for="password">Password</Label>
            <Input id="password" v-model="password" type="password" required autocomplete="current-password" placeholder="••••••••" />
          </div>

          <p v-if="error" class="text-sm text-destructive" role="alert">{{ error }}</p>

          <Button type="submit" :disabled="pending" class="w-full">
            {{ pending ? "Signing in…" : "Continue" }}
            <ArrowRight v-if="!pending" class="size-4" aria-hidden="true" />
          </Button>
        </form>
      </div>

      <p class="text-center text-xs text-muted-foreground">Internal tool · credentials are encrypted at rest</p>
    </main>

    <aside class="relative hidden flex-1 items-center justify-center overflow-hidden rounded-xl bg-[#f4f4f2] md:flex" aria-hidden="true">
      <svg viewBox="0 0 800 800" class="h-[85%] w-auto text-foreground/80" fill="none" stroke="currentColor" stroke-width="1.2">
        <ellipse cx="300" cy="400" rx="70" ry="300" />
        <ellipse cx="520" cy="400" rx="60" ry="260" stroke-dasharray="6 7" />
        <path d="M180 470 C 260 380, 420 330, 560 370 C 640 392, 690 380, 720 350" />
        <path d="M200 480 C 300 440, 460 420, 600 450" stroke-dasharray="3 6" />
        <path d="M560 370 C 580 320, 610 300, 650 310 M620 315 C 630 290, 655 285, 670 300" />
        <path d="M180 470 C 150 490, 130 520, 135 555 M150 520 C 170 540, 195 545, 215 538" />
        <path d="M560 420 L 620 440 M575 405 L 640 415" stroke-dasharray="4 5" />
        <path d="M120 620 h 520" stroke-dasharray="2 8" opacity="0.5" />
        <path d="M90 690 h 40 m10 0 h 40 m10 0 h 40" stroke-width="2.5" opacity="0.65" />
      </svg>
    </aside>
  </div>
</template>
