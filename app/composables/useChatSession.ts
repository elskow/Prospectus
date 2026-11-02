import { useChat } from "@ai-sdk/vue";
import { DefaultChatTransport } from "ai";
import type { UseChatHelpers } from "@ai-sdk/vue";
import type { UIMessage } from "ai";

let chatInstance: UseChatHelpers<UIMessage> | null = null;

const currentThreadId = (): string | null => threadIdRef.value;
let threadIdRef = ref<string | null>(null);

function chatOf(): UseChatHelpers<UIMessage> {
  if (!chatInstance) {
    chatInstance = useChat({
      transport: new DefaultChatTransport({
        api: "/api/chat",
        body: () => ({ threadId: currentThreadId() }),
      }),
    });
  }
  return chatInstance;
}

const ACTIVITY_LABELS: Record<string, string> = {
  findContactsTool: "Finding contact people",
  verifyEmailTool: "Verifying an email address",
  osintDomainTool: "Researching the company's domain",
  webSearchTool: "Searching the web",
  readPageTool: "Reading a page",
  runCampaignTool: "Running the campaign",
  createCampaignTool: "Creating the campaign",
  listCampaignsTool: "Listing your campaigns",
  leadLookupTool: "Looking up leads",
  updateIcpTool: "Updating the ICP",
  updateCampaignSettingsTool: "Updating campaign settings",
};

export interface ChatActivityItem {
  tool: string;
  label: string;
  state: string;
}

export function useChatSession(): UseChatHelpers<UIMessage> {
  return chatOf();
}

export function useChatActivity() {
  const chat = chatOf();

  const activity = computed<ChatActivityItem[]>(() => {
    const last = chat.messages.value[chat.messages.value.length - 1];
    if (!last) return [];
    const items: ChatActivityItem[] = [];
    for (const part of last.parts) {
      if (!part.type.startsWith("tool-")) continue;
      const tool = part.type.slice(5);
      const state = "state" in part ? String(part.state) : "done";
      items.push({ tool, state, label: ACTIVITY_LABELS[tool] ?? tool.replace(/Tool$/, "") });
    }
    return items;
  });

  const busy = computed(() => chat.status.value === "submitted" || chat.status.value === "streaming");

  const activeActivity = computed(() => activity.value.filter((a) => a.state !== "output-available" && a.state !== "output-error"));

  const reasoning = computed<string[]>(() => {
    const last = chat.messages.value[chat.messages.value.length - 1];
    if (!last || last.role !== "assistant") return [];
    const items: string[] = [];
    for (const part of last.parts) {
      if (part.type === "reasoning" && "text" in part && typeof part.text === "string" && part.text.trim()) {
        items.push(part.text.trim());
      }
    }
    return items;
  });

  const statusLabel = computed(() => {
    if (!busy.value) return null;
    const active = activeActivity.value[activeActivity.value.length - 1];
    if (!active) return chat.status.value === "submitted" ? "Starting…" : "Thinking…";
    return active.state === "input-streaming" ? `Preparing: ${active.label}…` : `${active.label}…`;
  });

  return { chat, activity, busy, statusLabel, reasoning };
}

export function setChatContext(threadId: string | null): void {
  threadIdRef.value = threadId;
}
