<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

export interface SelectOption {
  value: string
  label: string
  hint?: string
}

const props = defineProps<{
  modelValue: string
  options: SelectOption[]
  disabled?: boolean
  placeholder?: string
  width?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [string] }>()

const open = ref(false)
const root = ref<HTMLElement | null>(null)
const items = computed(() => props.options ?? [])

const shown = computed(() => {
  const hit = items.value.find((o) => o.value === props.modelValue)
  return hit?.label ?? props.placeholder ?? '请选择'
})

function pick(o: SelectOption) {
  emit('update:modelValue', o.value)
  open.value = false
}

function onDocClick(e: MouseEvent) {
  if (root.value && !root.value.contains(e.target as Node)) open.value = false
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') open.value = false
}

onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKey)
})
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <div ref="root" class="app-select" :style="width ? { width } : undefined">
    <button
      type="button"
      class="trigger"
      :class="{ open }"
      :disabled="disabled"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span class="label">{{ shown }}</span>
      <span class="caret" aria-hidden="true">▾</span>
    </button>

    <ul v-if="open" class="menu" role="listbox">
      <li
        v-for="o in items"
        :key="o.value"
        class="opt"
        :class="{ on: o.value === modelValue }"
        role="option"
        :aria-selected="o.value === modelValue"
        @click="pick(o)"
      >
        <span class="opt-label">{{ o.label }}</span>
        <span v-if="o.hint" class="opt-hint">{{ o.hint }}</span>
      </li>
      <li v-if="!items.length" class="opt-empty">暂无可选项</li>
    </ul>
  </div>
</template>

<style src="./AppSelect.css" scoped></style>
