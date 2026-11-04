<script setup lang="ts">
import { toast } from "vue-sonner";
import { KeyRound, Loader2, Trash2, UserPlus } from "lucide-vue-next";
import Button from "~/components/ui/button/Button.vue";
import Input from "~/components/ui/input/Input.vue";
import Label from "~/components/ui/label/Label.vue";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { formatDateTime } from "~/utils/datetime";
import { friendlyError } from "~/utils/errors";

definePageMeta({ middleware: "auth" });

useHead({ title: "Users · Prospectus" });

interface UserRow {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

const users = ref<UserRow[]>([]);
const loading = ref(true);

const inviteOpen = ref(false);
const inviteName = ref("");
const inviteEmail = ref("");
const invitePassword = ref("");
const inviteError = ref<string | null>(null);
const inviting = ref(false);

const resetOpen = ref(false);
const resetTarget = ref<UserRow | null>(null);
const resetPassword = ref("");
const resetError = ref<string | null>(null);
const resetting = ref(false);

const deleteOpen = ref(false);
const deleteTarget = ref<UserRow | null>(null);
const deleting = ref(false);

async function load() {
  loading.value = true;
  try {
    const res = await $fetch<{ users: UserRow[] }>("/api/users");
    users.value = res.users;
  } catch (err) {
    toast.error(friendlyError(err));
  } finally {
    loading.value = false;
  }
}

onMounted(load);

async function submitInvite() {
  inviteError.value = null;
  if (!inviteName.value.trim() || !inviteEmail.value.trim() || invitePassword.value.length < 8) {
    inviteError.value = "Name, email, and a password of at least 8 characters are required.";
    return;
  }
  inviting.value = true;
  try {
    await $fetch("/api/users", {
      method: "POST",
      body: { name: inviteName.value.trim(), email: inviteEmail.value.trim(), password: invitePassword.value },
    });
    toast.success(`${inviteName.value.trim()} invited.`);
    inviteOpen.value = false;
    inviteName.value = "";
    inviteEmail.value = "";
    invitePassword.value = "";
    await load();
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (message.includes("already registered")) inviteError.value = "That email is already registered";
    else inviteError.value = friendlyError(err);
  } finally {
    inviting.value = false;
  }
}

function openReset(user: UserRow) {
  resetTarget.value = user;
  resetPassword.value = "";
  resetError.value = null;
  resetOpen.value = true;
}

async function submitReset() {
  if (!resetTarget.value) return;
  resetError.value = null;
  if (resetPassword.value.length < 8) {
    resetError.value = "New password must be at least 8 characters.";
    return;
  }
  resetting.value = true;
  try {
    await $fetch(`/api/users/${resetTarget.value.id}/password`, {
      method: "PUT",
      body: { newPassword: resetPassword.value },
    });
    toast.success("Password reset. User must sign in again.");
    resetOpen.value = false;
    resetTarget.value = null;
    resetPassword.value = "";
  } catch (err) {
    resetError.value = friendlyError(err);
  } finally {
    resetting.value = false;
  }
}

function openDelete(user: UserRow) {
  deleteTarget.value = user;
  deleteOpen.value = true;
}

async function submitDelete() {
  if (!deleteTarget.value) return;
  deleting.value = true;
  try {
    await $fetch(`/api/users/${deleteTarget.value.id}`, { method: "DELETE" });
    toast.success(`${deleteTarget.value.name} deleted.`);
    deleteOpen.value = false;
    deleteTarget.value = null;
    await load();
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    toast.error(message.includes("cannot delete") ? "You cannot delete your own account." : friendlyError(err));
    if (message.includes("cannot delete")) deleteOpen.value = false;
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <div class="mx-auto h-full w-full max-w-5xl space-y-6 overflow-y-auto px-8 py-8">
    <div class="flex items-start justify-between">
      <div>
        <h1 class="text-xl font-semibold tracking-tight">User Management</h1>
        <p class="mt-1 text-sm text-muted-foreground">Invite teammates and manage workspace access.</p>
      </div>
      <Button size="sm" @click="inviteOpen = true">
        <UserPlus class="mr-2 size-4" aria-hidden="true" />
        Invite User
      </Button>
    </div>

    <div v-if="loading" class="space-y-2">
      <div v-for="i in 3" :key="i" class="h-14 animate-pulse rounded-xl border border-border bg-background" />
    </div>

    <div v-else-if="users.length === 0" class="rounded-xl border border-border bg-card px-5 py-12 text-center text-sm text-muted-foreground">
      No users yet. Invite your first teammate to get started.
    </div>

    <div v-else class="overflow-hidden rounded-xl border border-border">
      <table class="w-full text-sm">
        <thead>
          <tr class="border-b border-border bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th class="px-4 py-3 font-semibold">Name</th>
            <th class="px-4 py-3 font-semibold">Email</th>
            <th class="px-4 py-3 font-semibold">Created</th>
            <th class="px-4 py-3 text-right font-semibold">Actions</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="user in users" :key="user.id" class="border-b border-border/60 transition-colors last:border-b-0 hover:bg-muted/30">
            <td class="px-4 py-3 align-middle font-semibold">{{ user.name }}</td>
            <td class="px-4 py-3 align-middle">{{ user.email }}</td>
            <td class="px-4 py-3 align-middle text-muted-foreground">{{ formatDateTime(user.createdAt) }}</td>
            <td class="px-4 py-3 align-middle">
              <div class="flex justify-end gap-1">
                <Button variant="ghost" size="icon" title="Reset password" aria-label="Reset password" @click="openReset(user)">
                  <KeyRound class="size-4" aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  title="Delete user"
                  aria-label="Delete user"
                  class="text-destructive hover:text-destructive"
                  @click="openDelete(user)"
                >
                  <Trash2 class="size-4" aria-hidden="true" />
                </Button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <Dialog v-model:open="inviteOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite User</DialogTitle>
          <DialogDescription>Create an account for a new teammate.</DialogDescription>
        </DialogHeader>
        <form class="space-y-4" @submit.prevent="submitInvite">
          <div class="space-y-1.5">
            <Label for="invite-name">Name</Label>
            <Input id="invite-name" v-model="inviteName" required placeholder="Full name" />
          </div>
          <div class="space-y-1.5">
            <Label for="invite-email">Email</Label>
            <Input id="invite-email" v-model="inviteEmail" type="email" required placeholder="you@example.com" />
          </div>
          <div class="space-y-1.5">
            <Label for="invite-password">Password</Label>
            <Input id="invite-password" v-model="invitePassword" type="password" required minlength="8" placeholder="At least 8 characters" />
          </div>
          <p v-if="inviteError" class="text-xs text-destructive">{{ inviteError }}</p>
          <DialogFooter>
            <Button type="button" variant="outline" @click="inviteOpen = false">Cancel</Button>
            <Button type="submit" :disabled="inviting">
              <Loader2 v-if="inviting" class="mr-2 size-4 animate-spin" aria-hidden="true" />
              {{ inviting ? "Inviting…" : "Send invite" }}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="resetOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reset password</DialogTitle>
          <DialogDescription v-if="resetTarget">Set a new password for {{ resetTarget.name }}. They will need to sign in again.</DialogDescription>
        </DialogHeader>
        <form class="space-y-4" @submit.prevent="submitReset">
          <div class="space-y-1.5">
            <Label for="reset-password">New password</Label>
            <Input id="reset-password" v-model="resetPassword" type="password" required minlength="8" placeholder="At least 8 characters" />
          </div>
          <p v-if="resetError" class="text-xs text-destructive">{{ resetError }}</p>
          <DialogFooter>
            <Button type="button" variant="outline" @click="resetOpen = false">Cancel</Button>
            <Button type="submit" :disabled="resetting">
              <Loader2 v-if="resetting" class="mr-2 size-4 animate-spin" aria-hidden="true" />
              {{ resetting ? "Saving…" : "Reset password" }}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="deleteOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete user</DialogTitle>
          <DialogDescription v-if="deleteTarget">
            Delete {{ deleteTarget.name }}? Their campaigns and lead data will be permanently removed.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" @click="deleteOpen = false">Cancel</Button>
          <Button variant="destructive" :disabled="deleting" @click="submitDelete">
            <Loader2 v-if="deleting" class="mr-2 size-4 animate-spin" aria-hidden="true" />
            {{ deleting ? "Deleting…" : "Delete" }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
