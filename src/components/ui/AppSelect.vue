<script setup lang="ts">
import { t } from '@/i18n'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import AppButton from './AppButton.vue'

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
/**
 * 菜单用 fixed 定位贴在触发器旁边：
 * 输入框工具栏 `.tools-left` 有 overflow:hidden，绝对定位的菜单会被裁掉
 * （实测 composer 菜单 y=783、高 104，视口 800 → 只露 17px，点了像没反应）。
 * fixed 不受祖先 overflow 影响；下方空间不足时向上展开。
 */
const root = ref<HTMLElement | null>(null)
const menuStyle = ref<Record<string, string>>({})
const items = computed(() => props.options ?? [])

function toggle() {
  if (props.disabled) return
  if (!open.value) {
    const r = root.value?.getBoundingClientRect()
    if (r) {
      const up = window.innerHeight - r.bottom < 240 && r.top > 260
      menuStyle.value = {
        left: `${Math.round(r.left)}px`,
        minWidth: `${Math.round(r.width)}px`,
        ...(up
          ? { top: 'auto', bottom: `${Math.round(window.innerHeight - r.top + 4)}px` }
          : { top: `${Math.round(r.bottom + 4)}px`, bottom: 'auto' }),
      }
    }
  }
  open.value = !open.value
}

const shown = computed(() => {
  const hit = items.value.find((o) => o.value === props.modelValue)
  return hit?.label ?? props.placeholder ?? t('请选择')
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
  <!-- AUDIT-019：宽度经 CSS 自定义属性传入（功能性动态值，豁免纯样式抽离铁律），
       不再裸写 { width } 内联样式。 -->
  <div ref="root" class="app-select" :style="width ? { '--select-w': width } : undefined">
    <AppButton
      variant="secondary"
      class="trigger"
      :class="{ open }"
      :disabled="disabled"
      :aria-expanded="open"
      @click="toggle"
    >
      <span class="label">{{ shown }}</span>
      <!-- 禁用 = 纯展示：不留下拉箭头，别把只读值装成可点的选择器。 -->
      <span v-if="!disabled" class="caret" aria-hidden="true">▾</span>
    </AppButton>

    <ul v-if="open" class="menu" :style="menuStyle" role="listbox">
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
      <li v-if="!items.length" class="opt-empty">{{ t('暂无可选项') }}</li>
    </ul>
  </div>
</template>

<style src="./AppSelect.css" scoped></style>
