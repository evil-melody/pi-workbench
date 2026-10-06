<script setup lang="ts">
const props = defineProps<{
  open: boolean
  title: string
  size?: 'sm' | 'md' | 'lg'
}>()

const emit = defineEmits<{ close: [] }>()

function onBackdrop(e: MouseEvent) {
  if (e.target === e.currentTarget) emit('close')
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="open" class="modal-backdrop" role="dialog" aria-modal="true" @click="onBackdrop" @keydown="onKeydown">
        <div class="modal-panel" :class="size ?? 'md'" tabindex="-1">
          <div class="modal-header">
            <h3>{{ title }}</h3>
            <button class="modal-close" aria-label="关闭" @click="emit('close')">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </div>
          <div class="modal-body">
            <slot />
          </div>
          <div v-if="$slots.footer" class="modal-footer">
            <slot name="footer" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style src="./AppModal.css" scoped></style>
