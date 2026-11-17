<template>
  <div ref="rootEl" class="expert-picker" :style="{ width: width ?? 'auto' }">
    <AppButton
      type="button"
      variant="secondary"
      class="ep-trigger"
      :title="t('选择本次任务使用的专家；选多个按顺序接力')"
      :disabled="disabled"
      aria-haspopup="listbox"
      :aria-expanded="open"
      @click.stop="toggleMenu"
    >
      <AppIcon name="sparkles" :size="13" />
      <span class="ep-label">{{ triggerLabel }}</span>
      <AppIcon name="chevron-down" :size="12" />
    </AppButton>
    <Teleport to="body">
      <div v-if="open" ref="menuEl" class="ep-menu" :style="menuStyle" role="listbox" @click.stop>
        <p v-if="loading" class="ep-empty">{{ t('正在读取专家…') }}</p>
        <template v-else-if="failed">
          <p class="ep-empty">{{ t('专家清单读取失败（内核没有响应）。') }}</p>
          <div class="ep-actions">
            <AppButton variant="secondary" @click="load">{{ t('重试') }}</AppButton>
          </div>
        </template>
        <template v-else-if="!experts.length">
          <p class="ep-empty">{{ t('还没有专家。角色 ≠ 专家：专家接管工具与接力。') }}</p>
          <div class="ep-actions">
            <AppButton variant="secondary" @click="goCreate">{{ t('去「能力 → 专家」创建') }}</AppButton>
          </div>
        </template>
        <div
          v-for="e in experts"
          :key="e.id"
          class="ep-item"
          :class="{ on: orderOf(e.id) > 0 }"
          role="option"
          :aria-selected="orderOf(e.id) > 0"
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
        <div v-if="experts.length" class="ep-foot">
          <button v-if="modelValue.length" type="button" class="ep-clear" @click="clear">{{ t('清除选择') }}</button>
          <span class="ep-hint">{{ t('按勾选顺序接力，上一位产出作为下一位输入') }}</span>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
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

const router = useRouter()
const rootEl = ref<HTMLElement | null>(null)
const menuEl = ref<HTMLElement | null>(null)
const experts = ref<ExpertSummary[]>([])
const open = ref(false)
const loading = ref(true)
/**
 * 读取失败必须与「没有专家」分开：之前共用一个 `catch { experts = [] }`，
 * 内核不在线时会显示「还没有专家」，把用户引去重复创建。
 */
const failed = ref(false)

/** 菜单定位：fixed + 视口夹取 + 空间不足向上翻（与工具栏菜单同一套规则）。 */
const MENU_GAP = 6
const VIEW_PAD = 8
const MENU_MIN_W = 260
const MENU_EST_H = 320
const menuStyle = ref<Record<string, string>>({})

const triggerLabel = computed(() => {
  if (!props.modelValue.length) return t('专家')
  if (props.modelValue.length === 1) {
    return experts.value.find((e) => e.id === props.modelValue[0])?.name ?? props.modelValue[0]
  }
  return t('{0} 位专家接力', [props.modelValue.length])
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

/** 量一次触发器与菜单：下方放不下就翻到上方，左右夹在视口内。 */
function place() {
  const el = rootEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  const w = Math.min(Math.max(r.width, MENU_MIN_W), vw - VIEW_PAD * 2)
  const h = Math.min(menuEl.value?.offsetHeight || MENU_EST_H, vh - VIEW_PAD * 2)
  const below = vh - r.bottom - MENU_GAP - VIEW_PAD
  const above = r.top - MENU_GAP - VIEW_PAD
  // 下方空间连菜单高度都放不下、且上方更宽裕 → 向上展开。
  const up = below < h && above > below
  const top = up
    ? Math.max(VIEW_PAD, r.top - MENU_GAP - h)
    : Math.min(r.bottom + MENU_GAP, Math.max(VIEW_PAD, vh - VIEW_PAD - h))
  const left = Math.min(Math.max(VIEW_PAD, r.left), Math.max(VIEW_PAD, vw - w - VIEW_PAD))
  menuStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
    minWidth: `${Math.round(w)}px`,
    maxHeight: `${Math.max(160, vh - VIEW_PAD * 2)}px`,
  }
}

async function toggleMenu() {
  if (open.value) {
    open.value = false
    return
  }
  open.value = true
  place()
  await nextTick()
  // 挂载后才量得到真实高度，第二次定位才能决定向上/向下。
  place()
}

async function load() {
  loading.value = true
  failed.value = false
  try {
    experts.value = (await expertsList()).sort(
      (a, b) => Number(b.published) - Number(a.published) || a.name.localeCompare(b.name),
    )
  } catch {
    experts.value = []
    failed.value = true
  } finally {
    loading.value = false
    if (open.value) {
      await nextTick()
      place()
    }
  }
}

function goCreate() {
  open.value = false
  void router.push({ path: '/capabilities', query: { tab: 'expert' } })
}

function onDocClick() {
  if (open.value) open.value = false
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') open.value = false
}

watch(open, (v) => {
  if (v) {
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
  } else {
    window.removeEventListener('scroll', place, true)
    window.removeEventListener('resize', place)
  }
})

onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKey)
  void load()
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKey)
  window.removeEventListener('scroll', place, true)
  window.removeEventListener('resize', place)
})
</script>

<style src="./ExpertPicker.css" scoped></style>
