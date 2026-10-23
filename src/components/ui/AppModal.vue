<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps<{
  open: boolean
  title: string
  // xl：artifact 文档预览用（原手搓 overlay 是 960px，表格/文档需要更宽的面板）。
  size?: 'sm' | 'md' | 'lg' | 'xl'
}>()

// AUDIT-011：补 update:open 事件，让 v-model:open 双向绑定真正生效
// （此前只 emit close，调用方写 v-model:open 时静默不同步）。
const emit = defineEmits<{ close: []; 'update:open': [boolean] }>()

const panel = ref<HTMLElement | null>(null)
/** 打开前的焦点宿主：关闭时还原，键盘用户不被丢回文档头。 */
let restoreFocus: HTMLElement | null = null

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

/** 面板内可聚焦元素（过滤禁用与隐藏）。 */
function focusables(): HTMLElement[] {
  if (!panel.value) return []
  // 用 DOM 属性判断可见性而不是 offsetParent——后者在 jsdom 恒为 null，
  // 会让单测里所有可聚焦元素被误滤掉。
  return [...panel.value.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => !el.hasAttribute('disabled') && !el.hidden && !el.closest('[hidden]'),
  )
}

/** 关闭的统一出口：close 与 update:open 成对发出，保持两种绑定方式都正确。 */
function requestClose() {
  emit('close')
  emit('update:open', false)
}

function onBackdrop(e: MouseEvent) {
  if (e.target === e.currentTarget) requestClose()
}

/**
 * AUDIT-011：Tab 焦点陷阱——焦点锁在面板内循环，
 * 不会 Tab 到背后的页面上（原来可以，键盘用户会「走丢」）。
 */
function trapTab(e: KeyboardEvent) {
  if (e.key !== 'Tab' || !panel.value) return
  const items = focusables()
  if (!items.length) {
    e.preventDefault()
    panel.value.focus()
    return
  }
  const first = items[0]
  const last = items[items.length - 1]
  const active = document.activeElement as HTMLElement | null
  if (!active || !panel.value.contains(active)) {
    e.preventDefault()
    first.focus()
    return
  }
  if (e.shiftKey && active === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && active === last) {
    e.preventDefault()
    first.focus()
  }
}

/**
 * AUDIT-011：Esc 全局关闭。原来 Esc 挂在 backdrop 的 @keydown 上，
 * 只有焦点恰好在面板内才生效——多数情况下按了没反应。
 */
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') requestClose()
}

watch(
  () => props.open,
  async (open) => {
    if (open) {
      restoreFocus = document.activeElement as HTMLElement | null
      document.addEventListener('keydown', onKeydown)
      await nextTick()
      // 打开即聚焦：面板内首个可聚焦元素，没有则聚焦面板本身（tabindex=-1）。
      ;(focusables()[0] ?? panel.value)?.focus()
    } else {
      document.removeEventListener('keydown', onKeydown)
      restoreFocus?.focus()
      restoreFocus = null
    }
  },
  // immediate：挂载时 open 已为 true 的用法（打开即弹窗）也要注册 Esc 与聚焦。
  { immediate: true },
)

onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div
        v-if="open"
        ref="panel"
        class="modal-backdrop"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        @click="onBackdrop"
        @keydown="trapTab"
      >
        <div class="modal-panel" :class="size ?? 'md'">
          <div class="modal-header">
            <h3>{{ title }}</h3>
            <button class="modal-close" aria-label="关闭" @click="requestClose">
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
