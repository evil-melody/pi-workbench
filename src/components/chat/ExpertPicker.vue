<template>
  <div ref="rootEl" class="expert-picker" :style="{ width: width ?? 'auto' }">
    <AppButton
      type="button"
      variant="secondary"
      class="ep-trigger"
      :title="t('选择本次任务使用的专家；选多个按顺序接力')"
      :disabled="disabled"
      @click.stop="toggleMenu"
    >
      <AppIcon name="sparkles" :size="13" />
      <span class="ep-label">{{ triggerLabel }}</span>
      <AppIcon name="chevron-down" :size="12" />
    </AppButton>
    <Teleport to="body">
      <div v-if="open" class="ep-menu" :style="menuStyle" @click.stop>
        <p v-if="!experts.length" class="ep-empty">{{ t('还没有专家，先去「能力中心 → 专家」创建') }}</p>
        <div
          v-for="e in experts"
          :key="e.id"
          class="ep-item"
          :class="{ on: orderOf(e.id) > 0 }"
        >
          <AppCheckbox
            :model-value="orderOf(e.id) > 0"
            :label="e.name"
            @update:model-value="toggle(e.id)"
          />
          <span class="ep-item-meta">
            {{ e.tool_count ? t('{0} 个工具', [e.tool_count]) : t('不限工具') }}
            <template v-if="!e.published"> · {{ t('草稿') }}</template>
          </span>
          <span v-if="orderOf(e.id) > 0" class="ep-order">{{ orderOf(e.id) }}</span>
        </div>
        <div class="ep-foot">
          <button v-if="modelValue.length" type="button" class="ep-clear" @click="clear">{{ t('清除选择') }}</button>
          <span class="ep-hint">{{ t('按勾选顺序接力，上一位产出作为下一位输入') }}</span>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { t } from '@/i18n'
import AppButton from '@/components/ui/AppButton.vue'
import AppCheckbox from '@/components/ui/AppCheckbox.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import { expertsList, type ExpertSummary } from '@/composables/useExperts'

/**
 * 专家选择器：勾选顺序 = 接力顺序。
 * 只读取专家清单，不做写入；策略落盘由桥在发送时完成。
 */
const props = withDefaults(
  defineProps<{
    modelValue: string[]
    disabled?: boolean
    width?: string
  }>(),
  { disabled: false },
)
const emit = defineEmits<{ 'update:modelValue': [ids: string[]] }>()

const rootEl = ref<HTMLElement | null>(null)
const experts = ref<ExpertSummary[]>([])
const open = ref(false)
const anchor = ref<{ top: number; left: number; width: number } | null>(null)

const triggerLabel = computed(() => {
  if (!props.modelValue.length) return t('专家')
  if (props.modelValue.length === 1) {
    return experts.value.find((e) => e.id === props.modelValue[0])?.name ?? props.modelValue[0]
  }
  return t('{0} 位专家接力', [props.modelValue.length])
})

const menuStyle = computed(() => {
  if (!anchor.value) return {}
  return {
    top: `${anchor.value.top}px`,
    left: `${anchor.value.left}px`,
    minWidth: `${Math.max(anchor.value.width, 260)}px`,
  }
})

function orderOf(id: string): number {
  return props.modelValue.indexOf(id) + 1
}

function toggle(id: string) {
  const current = [...props.modelValue]
  const at = current.indexOf(id)
  if (at >= 0) current.splice(at, 1)
  else current.push(id)
  emit('update:modelValue', current)
}

function clear() {
  emit('update:modelValue', [])
  open.value = false
}

function toggleMenu() {
  if (open.value) {
    open.value = false
    return
  }
  const rect = rootEl.value?.getBoundingClientRect()
  anchor.value = rect
    ? { top: rect.bottom + 6, left: rect.left, width: rect.width }
    : { top: 12, left: 12, width: 260 }
  open.value = true
}

function onDocClick() {
  if (open.value) open.value = false
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') open.value = false
}

onMounted(async () => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKey)
  try {
    experts.value = (await expertsList()).sort(
      (a, b) => Number(b.published) - Number(a.published) || a.name.localeCompare(b.name),
    )
  } catch {
    experts.value = []
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKey)
})
</script>

<style src="./ExpertPicker.css" scoped></style>
