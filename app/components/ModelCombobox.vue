<script setup lang="ts">
import { ComboboxAnchor, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxPortal, ComboboxRoot, ComboboxTrigger } from "reka-ui";
import { ChevronDown, Search } from "lucide-vue-next";
import { computed, ref } from "vue";

const props = defineProps<{
  models: { id: string; label?: string }[];
  modelValue: string;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const query = ref("");
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return props.models;
  return props.models.filter((m) => `${m.label ?? ""} ${m.id}`.toLowerCase().includes(q));
});

const displayValue = computed(() => props.models.find((m) => m.id === props.modelValue)?.label ?? props.modelValue);
</script>

<template>
  <ComboboxRoot
    :model-value="modelValue"
    :reset-search-on-blur="true"
    @update:model-value="
      (value: string) => {
        query = '';
        emit('update:modelValue', value);
      }
    "
  >
    <ComboboxAnchor class="w-72">
      <ComboboxTrigger
        class="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <span class="min-w-0 truncate" :class="modelValue ? '' : 'text-muted-foreground'">{{ displayValue || "Select model" }}</span>
        <ChevronDown class="size-4 shrink-0 opacity-50" aria-hidden="true" />
      </ComboboxTrigger>
      <ComboboxInput v-model="query" class="sr-only" placeholder="Search models…" autocomplete="off" />
    </ComboboxAnchor>
    <ComboboxPortal>
      <ComboboxContent
        position="popper"
        :side-offset="4"
        :collision-padding="8"
        avoid-collisions
        class="z-[100] w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl ring-1 ring-black/5"
      >
        <div class="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            v-model="query"
            type="text"
            placeholder="Search models…"
            autocomplete="off"
            class="h-7 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            @keydown.enter.prevent
          />
          <button v-if="query" type="button" class="shrink-0 text-xs text-muted-foreground hover:text-foreground" @click="query = ''">Clear</button>
        </div>
        <div class="max-h-64 overflow-y-auto overflow-x-hidden overscroll-contain p-1">
          <ComboboxEmpty class="py-6 text-center text-sm text-muted-foreground">No models match "{{ query }}"</ComboboxEmpty>
          <ComboboxItem
            v-for="model in filtered"
            :key="model.id"
            :value="model.id"
            class="relative cursor-pointer select-none rounded-sm px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[state=checked]:font-medium"
          >
            <span class="block truncate">{{ model.label ?? model.id }}</span>
          </ComboboxItem>
        </div>
        <div class="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">{{ filtered.length }} of {{ models.length }} models</div>
      </ComboboxContent>
    </ComboboxPortal>
  </ComboboxRoot>
</template>
