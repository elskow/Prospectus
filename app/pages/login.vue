<script setup lang="ts">
import { ArrowRight } from "lucide-vue-next";

definePageMeta({ middleware: "guest" });

useHead({ title: "Sign in · Prospectus" });

const { login, register } = useAuth();

const mode = ref<"login" | "register">("login");
const email = ref("");
const name = ref("");
const password = ref("");
const error = ref<string | null>(null);
const pending = ref(false);

async function submit() {
  error.value = null;
  pending.value = true;
  try {
    if (mode.value === "login") {
      await login(email.value, password.value);
    } else {
      await register(email.value, name.value, password.value);
    }
    await navigateTo("/settings");
  } catch (err) {
    error.value = friendlyError(err);
  } finally {
    pending.value = false;
  }
}

function fillExample() {
  mode.value = "register";
  name.value = "Demo User";
  email.value = "demo@example.com";
  password.value = "demo-password-123";
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
        <h1 class="text-center text-xl font-bold tracking-tight">
          {{ mode === "login" ? "Welcome back" : "Get started with Prospectus" }}
        </h1>
        <p class="mt-1.5 text-center text-sm text-muted-foreground">
          {{ mode === "login" ? "Sign in to your lead generation workspace" : "One workspace for sourcing, qualifying, and exporting leads" }}
        </p>

        <form class="mt-8 space-y-3" :aria-label="mode === 'login' ? 'Sign in form' : 'Registration form'" @submit.prevent="submit">
          <div v-if="mode === 'register'" class="space-y-1.5">
            <Label for="name">Name</Label>
            <Input id="name" v-model="name" required autocomplete="name" placeholder="Your Name" />
          </div>
          <div class="space-y-1.5">
            <Label for="email">Email</Label>
            <Input id="email" v-model="email" type="email" required autocomplete="email" placeholder="you@example.com" />
          </div>
          <div class="space-y-1.5">
            <Label for="password">Password</Label>
            <Input
              id="password"
              v-model="password"
              type="password"
              required
              :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
              placeholder="••••••••"
            />
          </div>

          <p v-if="error" class="text-sm text-destructive" role="alert">{{ error }}</p>

          <Button type="submit" :disabled="pending" class="w-full">
            {{ pending ? "Working…" : mode === "login" ? "Continue" : "Create account" }}
            <ArrowRight v-if="!pending" class="size-4" aria-hidden="true" />
          </Button>
        </form>

        <div class="mt-5 flex items-center gap-3" role="separator" aria-label="or">
          <span class="h-px flex-1 border-t border-dashed border-border" />
          <span class="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">or</span>
          <span class="h-px flex-1 border-t border-dashed border-border" />
        </div>

        <p class="mt-5 text-center text-sm text-muted-foreground">
          <template v-if="mode === 'login'">
            New here?
            <button type="button" class="font-semibold text-foreground underline underline-offset-4" @click="mode = 'register'">Create an account</button>
          </template>
          <template v-else>
            Already have an account?
            <button type="button" class="font-semibold text-foreground underline underline-offset-4" @click="mode = 'login'">Sign in</button>
          </template>
        </p>

        <p class="mt-3 text-center text-xs text-muted-foreground">
          Just exploring?
          <button type="button" class="underline underline-offset-4 hover:text-foreground" @click="fillExample">Fill example data</button>
        </p>
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
