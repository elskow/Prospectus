<script setup lang="ts">
import { toast } from "vue-sonner";

definePageMeta({ middleware: "auth" });

useHead({ title: "Profile · Prospectus" });

const { user, fetchMe } = useAuth();

const loading = ref(true);
const name = ref("");
const savingProfile = ref(false);
const currentPassword = ref("");
const newPassword = ref("");
const confirmPassword = ref("");
const savingPassword = ref(false);
const passwordError = ref<string | null>(null);

onMounted(async () => {
  if (!user.value) await fetchMe();
  name.value = user.value?.name ?? "";
  loading.value = false;
});

async function saveProfile() {
  if (!name.value.trim()) return;
  savingProfile.value = true;
  try {
    const res = await $fetch<{ user: { id: string; email: string; name: string } }>("/api/auth/profile", {
      method: "PATCH",
      body: { name: name.value.trim() },
    });
    if (user.value) user.value.name = res.user.name;
    toast.success("Profile saved.");
  } catch (err) {
    toast.error(friendlyError(err));
  } finally {
    savingProfile.value = false;
  }
}

async function savePassword() {
  passwordError.value = null;
  if (newPassword.value.length < 8) {
    passwordError.value = "New password must be at least 8 characters.";
    return;
  }
  if (newPassword.value !== confirmPassword.value) {
    passwordError.value = "New passwords do not match.";
    return;
  }
  savingPassword.value = true;
  try {
    await $fetch("/api/auth/password", {
      method: "PUT",
      body: { currentPassword: currentPassword.value, newPassword: newPassword.value },
    });
    currentPassword.value = "";
    newPassword.value = "";
    confirmPassword.value = "";
    toast.success("Password changed.");
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("current password")) passwordError.value = "Current password is incorrect.";
    else toast.error(friendlyError(err));
  } finally {
    savingPassword.value = false;
  }
}
</script>

<template>
  <div class="mx-auto h-full w-full max-w-2xl space-y-10 overflow-y-auto px-8 py-8">
    <div>
      <h1 class="text-xl font-semibold tracking-tight">Profile</h1>
      <p class="mt-1 text-sm text-muted-foreground">Your account details. Platform connections and models are shared and live under Platform settings.</p>
    </div>

    <div v-if="loading" class="h-40 animate-pulse rounded-xl border border-border bg-background" />

    <template v-else>
      <section aria-labelledby="profile-details-heading">
        <h2 id="profile-details-heading" class="text-sm font-semibold uppercase tracking-widest text-muted-foreground">Account</h2>
        <div class="mt-4 space-y-4 rounded-xl border border-border bg-card px-5 py-5">
          <div class="space-y-1.5">
            <Label for="profile-email">Email</Label>
            <Input id="profile-email" :model-value="user?.email ?? ''" disabled />
            <p class="text-xs text-muted-foreground">Email is your sign-in identity and cannot be changed here yet.</p>
          </div>
          <div class="space-y-1.5">
            <Label for="profile-name">Display name</Label>
            <Input id="profile-name" v-model="name" placeholder="Your name" />
          </div>
          <div class="flex justify-end">
            <Button type="button" size="sm" :disabled="savingProfile || !name.trim()" @click="saveProfile">
              {{ savingProfile ? "Saving…" : "Save profile" }}
            </Button>
          </div>
        </div>
      </section>

      <section aria-labelledby="profile-password-heading">
        <h2 id="profile-password-heading" class="text-sm font-semibold uppercase tracking-widest text-muted-foreground">Password</h2>
        <form class="mt-4 space-y-4 rounded-xl border border-border bg-card px-5 py-5" @submit.prevent="savePassword">
          <div class="space-y-1.5">
            <Label for="profile-current-password">Current password</Label>
            <Input id="profile-current-password" v-model="currentPassword" type="password" required placeholder="••••••••" />
          </div>
          <div class="space-y-1.5">
            <Label for="profile-new-password">New password</Label>
            <Input id="profile-new-password" v-model="newPassword" type="password" required minlength="8" placeholder="At least 8 characters" />
          </div>
          <div class="space-y-1.5">
            <Label for="profile-confirm-password">Confirm new password</Label>
            <Input id="profile-confirm-password" v-model="confirmPassword" type="password" required minlength="8" placeholder="Repeat new password" />
          </div>
          <p v-if="passwordError" class="text-xs text-destructive">{{ passwordError }}</p>
          <div class="flex justify-end">
            <Button type="submit" size="sm" :disabled="savingPassword">
              {{ savingPassword ? "Saving…" : "Change password" }}
            </Button>
          </div>
        </form>
      </section>
    </template>
  </div>
</template>
