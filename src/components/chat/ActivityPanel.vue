<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import { usePiEventsInjected } from '@/composables/usePiEvents'
import { activityMessage, type ActivityState } from '@/composables/useActivity'
import { EVENT_KIND_ICON, EVENT_KIND_LABEL, type PiEventRow } from '@/utils/piEventKind'

const props = defineProps<{ state: ActivityState; running: boolean }>()

// 与「智能体浏览器」共用会话级缓冲；面板按需渲染，不另建订阅。
const stream = usePiEventsInjected()
const events = computed<PiEventRow[]>(() => stream?.events.value ?? [])
const stats = computed(() => stream?.stats.value ?? { total: 0, calls: 0, turns: 0, exits: 0 })

const listEl = ref<HTMLElement | null>(null)
/** 有新事件时贴底，保证「当前正在做什么」始终可见。 */
const pinned = ref(true)

function onScroll() {
  const el = listEl.value
  if (!el) return
  pinned.value = el.scrollHeight - el.scrollTop - el.clientHeight < 24
}

watch(
  () => events.value.length,
  async () => {
    if (!pinned.value) return
    await nextTick()
    const el = listEl.value
    if (el) el.scrollTop = el.scrollHeight
  },
)

function clock(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
</script>

<template>
  <div class="activity-panel">
    <div class="panel-head">
      <AppIcon name="activity" :size="14" />
      <span>智能体轨迹</span>
      <span class="panel-count" :title="`共 ${stats.total} 条事件`">{{ events.length }}</span>
    </div>

    <div class="status-card">
      <div class="status-row">
        <span class="dot" :class="`dot-${props.state.phase}`" />
        <strong>{{ activityMessage(props.state) }}</strong>
      </div>
      <div class="meta">
        <span>阶段：{{ props.state.phase }}</span>
        <span v-if="props.state.tool">工具：{{ props.state.tool }}</span>
        <span v-if="props.state.skill">技能：{{ props.state.skill }}</span>
      </div>
    </div>

    <div class="stat-row">
      <span class="stat"><b>{{ stats.calls }}</b> 次工具调用</span>
      <span class="stat"><b>{{ stats.turns }}</b> 轮</span>
      <span class="stat"><b>{{ stats.exits }}</b> 次进程退出</span>
    </div>

    <div ref="listEl" class="event-list" @scroll="onScroll">
      <p v-if="!events.length" class="empty">
        尚无事件。发起一轮对话后，内核事件会在这里按时间排列。
      </p>

      <div v-for="(ev, i) in events" :key="`${ev.at}-${i}`" class="event-item">
        <AppIcon :name="EVENT_KIND_ICON[ev.kind]" :size="13" />
        <span class="event-kind">{{ EVENT_KIND_LABEL[ev.kind] }}</span>
        <span class="event-name" :title="ev.detail">{{ ev.title }}</span>
        <span v-if="ev.detail" class="event-desc" :title="ev.detail">{{ ev.detail }}</span>
        <span class="event-time">{{ clock(ev.at) }}</span>
      </div>
    </div>

    <p class="note">
      事件由桥侧 <code>pi://event</code> 归一化而来；上方相位仍走流式状态的降级推断，
      细节以本列表为准。
    </p>
  </div>
</template>

<style src="./ActivityPanel.css" scoped></style>
