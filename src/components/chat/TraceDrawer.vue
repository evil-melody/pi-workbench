<script setup lang="ts">
import { t } from '@/i18n'
/**
 * 过程抽屉：会话树 / 轨迹 / 工作流 / 连接器。
 *
 * 这些是「过程」不是「主内容」——默认收起，点开才占宽度，
 * 关着的时候连内容都不挂载（会话树自己会轮询，关着还挂等于白烧 IPC）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppButton from '@/components/ui/AppButton.vue'
import SessionTree from '@/components/chat/SessionTree.vue'
import ActivityPanel from '@/components/chat/ActivityPanel.vue'
import WorkflowPanel from '@/components/chat/WorkflowPanel.vue'
import ConnectorPanel from '@/components/connectors/ConnectorPanel.vue'
import type { ActivityState } from '@/composables/useActivity'
import type { PiUsage } from '@/composables/piEvents'
import type { PiMsg } from '@/composables/usePi'
import { onTablistKeydown } from '@/composables/useTablist'

const props = defineProps<{
  open: boolean
  /** 本轮工具调用次数，给「轨迹」tab 做徽标。 */
  calls: number
  state: ActivityState
  running: boolean
  messages: PiMsg[]
  sessionId: string
  /** F10 从 composer 迁出的统计与索引状态，透传给「轨迹」tab。 */
  usage?: PiUsage | null
  turns?: number
  steps?: number
  projectId?: string | null
}>()

const emit = defineEmits<{ close: [] }>()

type Tab = 'tree' | 'activity' | 'workflow' | 'connector'

const TABS = computed<Array<{ key: Tab; label: string; icon: string }>>(() => [
  { key: 'tree', label: t('会话树'), icon: 'clock' },
  { key: 'activity', label: t('轨迹'), icon: 'activity' },
  { key: 'workflow', label: t('工作流'), icon: 'list' },
  { key: 'connector', label: t('连接器'), icon: 'plug' },
])

const tab = ref<Tab>('activity')

// 收起时记住 tab 没意义，下次打开还是先看轨迹（最常用）。
watch(
  () => props.open,
  (open) => {
    if (!open) tab.value = 'activity'
  },
)

/*
 * 窄窗下标签条会横向溢出（900px 时 304 > 267）。macOS 的覆盖式滚动条高度为 0，
 * 光靠滚动条看不出还有内容，所以两件事：聚焦时把标签滚进来，溢出时边缘渐隐提示。
 * 滚动只发生在标签条自己身上，不带动页面。
 */
const tabsEl = ref<HTMLElement | null>(null)
const canLeft = ref(false)
const canRight = ref(false)

function motionBehavior(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}

function syncTabsScroll() {
  const el = tabsEl.value
  if (!el) return
  canLeft.value = el.scrollLeft > 1
  canRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
}

function onTabsFocusIn(e: FocusEvent) {
  const el = tabsEl.value
  const target = e.target as HTMLElement | null
  if (!el || !target || !el.contains(target)) return
  const bar = el.getBoundingClientRect()
  const r = target.getBoundingClientRect()
  if (r.left < bar.left) el.scrollBy({ left: r.left - bar.left, behavior: motionBehavior() })
  else if (r.right > bar.right) el.scrollBy({ left: r.right - bar.right, behavior: motionBehavior() })
}

let tabsObserver: ResizeObserver | null = null

onMounted(() => {
  if (!tabsEl.value) return
  tabsObserver = new ResizeObserver(() => syncTabsScroll())
  tabsObserver.observe(tabsEl.value)
  syncTabsScroll()
})

onBeforeUnmount(() => tabsObserver?.disconnect())

watch(
  () => props.open,
  () => nextTick(syncTabsScroll),
)
</script>

<template>
  <aside class="trace-drawer" :class="{ open }" :aria-hidden="!open">
    <header class="td-head">
      <nav
        ref="tabsEl"
        class="td-tabs"
        :class="{ 'fade-left': canLeft, 'fade-right': canRight }"
        role="tablist"
        :aria-label="t('过程面板')"
        @keydown="onTablistKeydown"
        @scroll.passive="syncTabsScroll"
        @focusin="onTabsFocusIn"
      >
        <AppButton
          v-for="item in TABS"
          :key="item.key"
          variant="tab"
          role="tab"
          :aria-selected="tab === item.key"
          :tabindex="tab === item.key ? 0 : -1"
          class="td-tab"
          :class="{ on: tab === item.key }"
          @click="tab = item.key"
        >
          <AppIcon :name="item.icon" :size="13" />
          <span>{{ item.label }}</span>
          <i v-if="item.key === 'activity' && calls" class="td-badge" :title="t('本轮工具调用次数')">{{ calls }}</i>
        </AppButton>
      </nav>
      <AppButton variant="icon" class="td-close" :title="t('收起过程面板')" @click="emit('close')">
        <AppIcon name="close" :size="14" />
      </AppButton>
    </header>

    <div v-if="open" class="td-body">
      <SessionTree v-if="tab === 'tree'" :auto-refresh="tab === 'tree'" />
      <ActivityPanel
        v-else-if="tab === 'activity'"
        :state="state"
        :running="running"
        :usage="usage"
        :turns="turns"
        :steps="steps"
        :project-id="projectId"
      />
      <WorkflowPanel v-else-if="tab === 'workflow'" :state="state" :running="running" :messages="messages" />
      <ConnectorPanel v-else-if="tab === 'connector'" :session-id="sessionId" />
    </div>
  </aside>
</template>

<style src="./TraceDrawer.css" scoped></style>
