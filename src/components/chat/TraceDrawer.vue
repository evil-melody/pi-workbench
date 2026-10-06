<script setup lang="ts">
/**
 * 过程抽屉：会话树 / 轨迹 / 工作流 / 连接器。
 *
 * 这些是「过程」不是「主内容」——默认收起，点开才占宽度，
 * 关着的时候连内容都不挂载（会话树自己会轮询，关着还挂等于白烧 IPC）。
 */
import { ref, watch } from 'vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import SessionTree from '@/components/chat/SessionTree.vue'
import ActivityPanel from '@/components/chat/ActivityPanel.vue'
import WorkflowPanel from '@/components/chat/WorkflowPanel.vue'
import ConnectorPanel from '@/components/connectors/ConnectorPanel.vue'
import type { ActivityState } from '@/composables/useActivity'
import type { PiMsg } from '@/composables/usePi'

const props = defineProps<{
  open: boolean
  /** 本轮工具调用次数，给「轨迹」tab 做徽标。 */
  calls: number
  state: ActivityState
  running: boolean
  messages: PiMsg[]
  sessionId: string
}>()

const emit = defineEmits<{ close: [] }>()

type Tab = 'tree' | 'activity' | 'workflow' | 'connector'

const TABS: Array<{ key: Tab; label: string; icon: string }> = [
  { key: 'tree', label: '会话树', icon: 'clock' },
  { key: 'activity', label: '轨迹', icon: 'activity' },
  { key: 'workflow', label: '工作流', icon: 'list' },
  { key: 'connector', label: '连接器', icon: 'plug' },
]

const tab = ref<Tab>('activity')

// 收起时记住 tab 没意义，下次打开还是先看轨迹（最常用）。
watch(
  () => props.open,
  (open) => {
    if (!open) tab.value = 'activity'
  },
)
</script>

<template>
  <aside class="trace-drawer" :class="{ open }" :aria-hidden="!open">
    <header class="td-head">
      <nav class="td-tabs">
        <button
          v-for="t in TABS"
          :key="t.key"
          class="td-tab"
          :class="{ on: tab === t.key }"
          @click="tab = t.key"
        >
          <AppIcon :name="t.icon" :size="13" />
          <span>{{ t.label }}</span>
          <i v-if="t.key === 'activity' && calls" class="td-badge" title="本轮工具调用次数">{{ calls }}</i>
        </button>
      </nav>
      <button class="td-close" title="收起过程面板" @click="emit('close')">
        <AppIcon name="close" :size="14" />
      </button>
    </header>

    <div v-if="open" class="td-body">
      <SessionTree v-if="tab === 'tree'" :auto-refresh="tab === 'tree'" />
      <ActivityPanel v-else-if="tab === 'activity'" :state="state" :running="running" />
      <WorkflowPanel v-else-if="tab === 'workflow'" :state="state" :running="running" :messages="messages" />
      <ConnectorPanel v-else :session-id="sessionId" />
    </div>
  </aside>
</template>

<style src="./TraceDrawer.css" scoped></style>
