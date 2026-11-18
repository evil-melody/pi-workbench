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
import AgentLanes from '@/components/chat/AgentLanes.vue'
import WorkflowPanel from '@/components/chat/WorkflowPanel.vue'
import ConnectorPanel from '@/components/connectors/ConnectorPanel.vue'
import WorktreePanel from '@/components/worktrees/WorktreePanel.vue'
import type { ActivityState } from '@/composables/useActivity'
import type { PiUsage } from '@/composables/piEvents'
import type { PiMsg } from '@/composables/usePi'
import { onTablistKeydown } from '@/composables/useTablist'
import { useRunFocus } from '@/composables/useRunFocus'

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
  /** 外部指定的页签（如顶栏「工作区」按钮直接落到这一页）。 */
  focusTab?: string
  /** 仓库根目录：工作区页签据此列 worktree。 */
  root?: string
  /** 当前会话的内核工作目录：用于标出「当前会话」所在 worktree。 */
  cwd?: string
}>()

const emit = defineEmits<{
  close: []
  'enter-worktree': [payload: { path: string; branch: string }]
}>()

type Tab = 'tree' | 'activity' | 'agents' | 'workflow' | 'connector' | 'worktree'

const TABS = computed<Array<{ key: Tab; label: string; icon: string }>>(() => [
  { key: 'tree', label: t('会话树'), icon: 'clock' },
  { key: 'activity', label: t('轨迹'), icon: 'activity' },
  { key: 'agents', label: t('智能体'), icon: 'users' },
  { key: 'workflow', label: t('工作流'), icon: 'list' },
  { key: 'connector', label: t('连接器'), icon: 'plug' },
  { key: 'worktree', label: t('并行工作区'), icon: 'layers' },
])

const tab = ref<Tab>('activity')

/** 顶栏「工作区」按钮：打开抽屉并直接落在工作区页签。 */
watch(
  () => props.focusTab,
  (v) => {
    if (v && props.open && (TABS.value.some((x) => x.key === v))) tab.value = v as Tab
  },
)

/** 气泡下的「运行链路」入口只指向轨迹页签：抽屉已开着时也要切回来。 */
const { focusSeq } = useRunFocus()
watch(focusSeq, () => {
  tab.value = 'activity'
})

// 收起时记住 tab 没意义，下次打开还是先看轨迹（最常用）；
// 但外部指定了页签（顶栏「工作区」按钮）时以它为准。
watch(
  () => props.open,
  (open) => {
    if (!open) {
      tab.value = 'activity'
      return
    }
    if (props.focusTab && TABS.value.some((x) => x.key === props.focusTab)) {
      tab.value = props.focusTab as Tab
    }
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
      <AgentLanes v-else-if="tab === 'agents'" :state="state" :running="running" />
      <WorkflowPanel v-else-if="tab === 'workflow'" :state="state" :running="running" :messages="messages" />
      <div v-else-if="tab === 'connector'" class="td-pane">
        <ConnectorPanel :session-id="sessionId" />
      </div>
      <div v-else-if="tab === 'worktree'" class="td-pane">
        <WorktreePanel :root="root" :cwd="cwd" @enter="emit('enter-worktree', $event)" />
      </div>
    </div>
  </aside>
</template>

<style src="./TraceDrawer.css" scoped></style>
