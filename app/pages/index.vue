<script setup lang="ts">
import type { UIMessage } from "ai";
import { useChatActivity, useChatSession, setChatContext } from "@app/composables/useChatSession";
import { marked } from "marked";
import { Pencil } from "lucide-vue-next";

definePageMeta({ middleware: ["auth"] });

useHead({ title: "Prospectus" });

marked.setOptions({ async: false, gfm: true, breaks: true });

function renderMarkdown(text: string) {
  return marked.parse(text) as string;
}

interface HistoryPart {
  type: "text" | "tool";
  role: string;
  text?: string;
  toolName?: string;
  state?: string;
}

interface HistoryMessage {
  id: string;
  role: string;
  createdAt: string;
  parts: HistoryPart[];
}

interface ThreadSummary {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

const { user } = useAuth();

const activeThreadId = ref<string>(crypto.randomUUID());
const threads = ref<ThreadSummary[]>([]);
const historyOpen = ref(false);
const historyRoot = ref<HTMLElement | null>(null);
const renamingThread = ref<ThreadSummary | null>(null);
const renameDraft = ref("");

function onDocClick(event: MouseEvent) {
  if (historyOpen.value && historyRoot.value && !historyRoot.value.contains(event.target as Node)) {
    historyOpen.value = false;
  }
}

function onDocKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && !renamingThread.value) historyOpen.value = false;
}

onMounted(() => {
  document.addEventListener("click", onDocClick);
  document.addEventListener("keydown", onDocKeydown);
});
onBeforeUnmount(() => {
  document.removeEventListener("click", onDocClick);
  document.removeEventListener("keydown", onDocKeydown);
});

const chat = useChatSession();
const { busy, statusLabel, reasoning, activity } = useChatActivity();

watch(activeThreadId, (id) => setChatContext(id), { immediate: true });

const input = ref("");
const historyLoading = ref(true);

const TOOL_STATE_TO_LABEL: Record<string, string> = {
  "input-streaming": "pending",
  "input-available": "running",
  "output-available": "done",
  "output-error": "error",
};

const TOOL_STATE_TO_CLASS: Record<string, string> = {
  "input-streaming": "text-muted-foreground",
  "input-available": "text-warning",
  "output-available": "text-success",
  "output-error": "text-destructive",
};

function activityLabelFor(toolPart: string) {
  return activity.value.find((a) => a.tool === toolPart)?.label ?? toolPart.replace(/Tool$/, "");
}

function send() {
  const text = input.value.trim();
  if (!text) return;
  persistThreadId();
  chat.sendMessage({ text });
  input.value = "";
}

const examples = ["run my campaign", "find 5 new industrial suppliers in Bandung", "find coffee roasters in Jakarta with a website"];

const scrollEl = ref<HTMLElement | null>(null);

function scrollToBottom() {
  nextTick(() => {
    scrollEl.value?.scrollTo({ top: scrollEl.value.scrollHeight, behavior: "smooth" });
  });
}

watch(() => chat.messages.value.length, scrollToBottom);
watch(busy, scrollToBottom);

function toUiMessages(messages: HistoryMessage[]): UIMessage[] {
  return messages.map((m) => ({
    id: m.id,
    role: m.role === "assistant" ? "assistant" : "user",
    parts: m.parts.map((p, i): UIMessage["parts"][number] =>
      p.type === "text"
        ? { type: "text", text: p.text ?? "" }
        : ({
            type: `tool-${p.toolName ?? "tool"}`,
            toolCallId: `${m.id}-${i}`,
            state: p.state === "result" ? "output-available" : (p.state ?? "output-available"),
          } as UIMessage["parts"][number]),
    ),
  }));
}

function isStreaming() {
  return busy.value && chat.messages.value.length > 0;
}

async function loadThreadMessages(threadId: string) {
  if (threadId === activeThreadId.value && isStreaming()) return;
  historyLoading.value = true;
  try {
    const res = await $fetch<{ messages: HistoryMessage[] }>(`/api/chat/history?threadId=${threadId}`);
    chat.messages.value = toUiMessages(res.messages);
  } catch {
    chat.messages.value = [];
  }
  historyLoading.value = false;
  scrollToBottom();
}

async function loadThreads() {
  try {
    const res = await $fetch<{ threads: ThreadSummary[] }>("/api/chat/threads", {});
    threads.value = res.threads;
  } catch {}
}

function selectThread(id: string) {
  if (id === activeThreadId.value) return;
  activeThreadId.value = id;
  loadThreadMessages(id);
}

function newChat() {
  activeThreadId.value = crypto.randomUUID();
  chat.messages.value = [];
  input.value = "";
  scrollToBottom();
}

function startRename(thread: ThreadSummary) {
  renamingThread.value = thread;
  renameDraft.value = thread.title ?? "";
}

const activeThread = computed(() => threads.value.find((t) => t.id === activeThreadId.value) ?? null);
const headerTitle = computed(() => activeThread.value?.title ?? "New Chat");
const headerEditing = ref(false);
const headerEditInput = ref<HTMLInputElement | null>(null);

watch(headerEditing, (editing) => {
  if (editing) nextTick(() => headerEditInput.value?.select());
});

function startHeaderRename() {
  if (!activeThread.value || !hasMessages.value) return;
  renameDraft.value = activeThread.value.title ?? "";
  headerEditing.value = true;
}

async function confirmHeaderRename() {
  const thread = activeThread.value;
  const title = renameDraft.value.trim();
  headerEditing.value = false;
  if (!thread || !title || title === thread.title) return;
  try {
    await $fetch(`/api/chat/threads/${thread.id}`, {
      method: "PATCH",
      body: { title },
    });
  } catch {}
  await loadThreads();
}

async function confirmRename() {
  const thread = renamingThread.value;
  const title = renameDraft.value.trim();
  renamingThread.value = null;
  if (!thread || !title || title === thread.title) return;
  try {
    await $fetch(`/api/chat/threads/${thread.id}`, {
      method: "PATCH",
      body: { title },
    });
    await loadThreads();
  } catch {
    await loadThreads();
  }
}

async function deleteThread(thread: ThreadSummary) {
  try {
    await $fetch(`/api/chat/threads/${thread.id}`, {
      method: "DELETE",
    });
    if (thread.id === activeThreadId.value) {
      newChat();
      await loadThreadMessages(activeThreadId.value);
    }
    await loadThreads();
    if (threads.value.length === 0) historyOpen.value = false;
  } catch {}
}

function relativeTime(iso: string | null) {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function persistThreadId() {
  localStorage.setItem("lgp-thread", activeThreadId.value);
}

watch(activeThreadId, persistThreadId);

async function restoreLastThread() {
  const saved = localStorage.getItem("lgp-thread");
  await loadThreads();
  if (!saved) return;
  if (threads.value.some((t) => t.id === saved)) {
    activeThreadId.value = saved;
    await loadThreadMessages(saved);
  }
}

onMounted(async () => {
  if (isStreaming()) {
    historyLoading.value = false;
    scrollToBottom();
    return;
  }
  await restoreLastThread();
  await loadThreadMessages(activeThreadId.value);
});

const hasMessages = computed(() => chat.messages.value.length > 0);

watch(busy, (now, before) => {
  if (before && !now) loadThreads();
});

const emptyStateExamples = computed(() => (hasMessages.value ? [] : examples));
</script>

<template>
  <div class="mx-auto flex h-full w-full max-w-7xl flex-col px-8 py-5">
    <div class="flex items-center justify-between pb-4">
      <input
        v-if="headerEditing"
        ref="headerEditInput"
        v-model="renameDraft"
        class="w-72 rounded-md border border-border bg-background px-2 py-1 text-lg font-semibold tracking-tight focus:outline-none focus:ring-1 focus:ring-ring"
        aria-label="Thread title"
        @keydown.enter.prevent="confirmHeaderRename"
        @keydown.esc="headerEditing = false"
        @blur="confirmHeaderRename"
      />
      <button
        v-else
        type="button"
        class="group flex items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-muted/50"
        :disabled="!hasMessages"
        :aria-label="hasMessages ? 'Rename conversation' : undefined"
        @click="startHeaderRename"
      >
        <span class="text-lg font-semibold tracking-tight">{{ headerTitle }}</span>
        <Pencil v-if="hasMessages" class="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" aria-hidden="true" />
      </button>
      <div class="relative flex items-center gap-2" ref="historyRoot">
        <button
          type="button"
          :disabled="busy || threads.length === 0"
          class="flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          aria-haspopup="listbox"
          :aria-expanded="historyOpen"
          aria-label="Conversation history"
          @click="historyOpen = !historyOpen"
        >
          <svg
            viewBox="0 0 24 24"
            class="size-4"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M3 12a9 9 0 1 0 9-9" />
            <path d="M3 4v5h5" />
            <path d="M12 7v5l3 3" />
          </svg>
          History
          <svg
            viewBox="0 0 24 24"
            class="size-3.5 transition-transform"
            :class="historyOpen ? 'rotate-180' : ''"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <div
          v-if="historyOpen"
          class="absolute right-0 top-full z-30 mt-1.5 max-h-80 w-72 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-md"
          role="listbox"
          aria-label="Conversations"
        >
          <div v-for="t in threads" :key="t.id" role="option" :aria-selected="t.id === activeThreadId">
            <div v-if="renamingThread?.id === t.id" class="flex items-center gap-1.5 px-2 py-1.5">
              <input
                v-model="renameDraft"
                type="text"
                class="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm outline-none focus:border-ring"
                aria-label="Conversation title"
                @keydown.enter="confirmRename"
                @keydown.escape="renamingThread = null"
                @vue:mounted="($event.el as HTMLInputElement)?.focus?.()"
              />
              <button
                type="button"
                class="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                aria-label="Save title"
                @click="confirmRename"
              >
                <svg
                  viewBox="0 0 24 24"
                  class="size-4"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                >
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              </button>
            </div>
            <div
              v-else
              :class="[
                'group flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 transition-colors my-1',
                t.id === activeThreadId ? 'bg-secondary text-secondary-foreground' : 'text-foreground hover:bg-muted',
              ]"
            >
              <button
                type="button"
                class="min-w-0 flex-1 text-left"
                @click="
                  selectThread(t.id);
                  historyOpen = false;
                "
              >
                <span class="block truncate text-sm font-medium">{{ t.title ?? "New conversation" }}</span>
                <span class="block text-[11px] text-muted-foreground">{{ relativeTime(t.updatedAt) }}</span>
              </button>
              <span class="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  type="button"
                  class="rounded-md p-1 text-muted-foreground transition-colors hover:bg-background hover:text-foreground"
                  :aria-label="`Rename conversation`"
                  @click.stop="startRename(t)"
                >
                  <svg
                    viewBox="0 0 24 24"
                    class="size-3.5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M12 20h9" />
                    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                  </svg>
                </button>
                <button
                  type="button"
                  class="rounded-md p-1 text-muted-foreground transition-colors hover:bg-background hover:text-destructive"
                  :aria-label="`Delete conversation`"
                  @click.stop="deleteThread(t)"
                >
                  <svg
                    viewBox="0 0 24 24"
                    class="size-3.5"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <path d="M3 6h18" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              </span>
            </div>
          </div>
        </div>
        <button
          type="button"
          :disabled="busy"
          class="flex h-9 items-center gap-2 rounded-lg border border-border bg-card px-3.5 text-sm font-medium transition-colors hover:border-foreground/40 disabled:pointer-events-none disabled:opacity-50"
          aria-label="Start a new chat"
          @click="
            newChat();
            historyOpen = false;
          "
        >
          <svg
            viewBox="0 0 24 24"
            class="size-4"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
          </svg>
          New Chat
        </button>
      </div>
    </div>

    <div class="flex min-h-0 flex-1">
      <div class="flex min-w-0 flex-1 flex-col">
        <div ref="scrollEl" class="min-h-0 flex-1 space-y-6 overflow-y-auto px-2 py-4" role="log" aria-label="Conversation" aria-live="polite">
          <div v-if="!hasMessages && !historyLoading" class="flex h-full flex-col items-center justify-center pb-16 text-center">
            <span class="mb-4 flex size-10 items-center justify-center rounded-lg bg-primary/15 text-primary" aria-hidden="true">
              <svg viewBox="0 0 24 24" class="size-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M12 20V10" />
                <path d="M12 10c0-4 3-7 8-7 0 5-3 8-8 8Z" fill="currentColor" stroke="none" />
              </svg>
            </span>
            <p class="text-base font-medium">Hi {{ user?.name ?? "there" }}, what leads are you hunting?</p>
            <p class="mt-2 max-w-md text-sm text-muted-foreground">
              Ask for leads in plain language. I'll search Google Maps, visit the companies, qualify them against your campaign's ICP, and store what passes.
            </p>
            <div class="mt-6 flex flex-wrap justify-center gap-2">
              <button
                v-for="example in emptyStateExamples"
                :key="example"
                type="button"
                class="rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
                @click="chat.sendMessage({ text: example })"
              >
                {{ example }}
              </button>
            </div>
          </div>

          <div v-for="message in chat.messages.value" :key="message.id" class="space-y-1.5">
            <template v-for="(part, i) in message.parts" :key="`${message.id}-${i}`">
              <div
                v-if="part.type === 'text'"
                :class="[
                  'text-sm',
                  message.role === 'user'
                    ? 'ml-auto w-fit max-w-[75%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-primary-foreground whitespace-pre-wrap'
                    : 'mr-auto max-w-[85%] text-foreground/95',
                ]"
              >
                <template v-if="message.role === 'user'">{{ part.text }}</template>
                <div v-else class="chat-prose prose prose-sm max-w-none" v-html="renderMarkdown(part.text ?? '')" />
              </div>

              <div v-else-if="part.type?.startsWith('tool-')" class="mr-auto max-w-[85%] rounded-lg border border-border bg-card px-3 py-2 text-xs">
                <div class="flex items-center gap-2">
                  <span class="font-medium text-foreground">{{ activityLabelFor(part.type.replace("tool-", "")) }}</span>
                  <span :class="TOOL_STATE_TO_CLASS[part.state ?? ''] ?? ''" class="text-[11px]">
                    {{ TOOL_STATE_TO_LABEL[part.state ?? ""] ?? part.state }}
                  </span>
                </div>
                <details v-if="part.input || part.output" class="mt-1">
                  <summary class="cursor-pointer text-muted-foreground hover:text-foreground">details</summary>
                  <pre v-if="part.input" class="mt-1 overflow-x-auto text-muted-foreground">{{ JSON.stringify(part.input, null, 2) }}</pre>
                  <pre v-if="part.output" class="mt-1 overflow-x-auto text-muted-foreground">{{ JSON.stringify(part.output, null, 2) }}</pre>
                </details>
              </div>
            </template>
          </div>

          <div v-if="busy" class="space-y-1.5" role="status" aria-live="polite">
            <div class="flex items-center gap-2 text-xs font-medium text-foreground/70">
              <span class="size-1.5 animate-pulse rounded-full bg-foreground/50" aria-hidden="true" />
              {{ statusLabel ?? "Thinking…" }}
            </div>
            <div
              v-for="(step, ri) in reasoning"
              :key="`reasoning-${ri}`"
              class="mr-auto max-w-[85%] rounded-lg border-l-2 border-primary/40 bg-muted/40 px-3 py-1.5 text-xs italic text-muted-foreground"
            >
              {{ step }}
            </div>
          </div>
        </div>

        <form class="flex items-center gap-2 pt-3" aria-label="Send a message" @submit.prevent="send">
          <Input v-model="input" placeholder="Ask for leads…" aria-label="Message" :disabled="busy" class="h-11 flex-1 rounded-xl bg-card" />
          <Button type="submit" :disabled="!input.trim() || busy" class="h-11 rounded-xl px-5"> Send </Button>
        </form>
      </div>
    </div>
  </div>
</template>

<style>
.chat-prose {
  --tw-prose-body: var(--foreground);
  --tw-prose-headings: var(--foreground);
  --tw-prose-links: var(--primary);
  --tw-prose-bold: var(--foreground);
  --tw-prose-code: var(--foreground);
  --tw-prose-quotes: var(--muted-foreground);
  --tw-prose-quote-borders: var(--border);
  --tw-prose-bullets: var(--muted-foreground);
  --tw-prose-counters: var(--muted-foreground);
  --tw-prose-hr: var(--border);
  --tw-prose-th-borders: var(--border);
  --tw-prose-td-borders: var(--border);
  font-size: 0.875rem;
  line-height: 1.65;
}
.chat-prose :where(p, ul, ol, pre, blockquote, table):first-child {
  margin-top: 0;
}
.chat-prose :where(p, ul, ol, pre, blockquote, table):last-child {
  margin-bottom: 0;
}
.chat-prose :where(code):not(:where(pre code))::before,
.chat-prose :where(code):not(:where(pre code))::after {
  content: none;
}
.chat-prose :where(pre) {
  background: var(--muted);
  color: var(--foreground);
  border: 1px solid var(--border);
  border-radius: 0.5rem;
  font-size: 0.8125rem;
}
.chat-prose :where(code):not(:where(pre code)) {
  background: var(--muted);
  border-radius: 0.25rem;
  padding: 0.1rem 0.3rem;
  font-weight: 500;
  font-size: 0.8125rem;
}
.chat-prose :where(table) {
  font-size: 0.8125rem;
}
.chat-prose :where(pre code) {
  border: 0;
}
</style>
