<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import AppIcon from '@/components/ui/AppIcon.vue'
import { usePiEventsInjected } from '@/composables/usePiEvents'
import { activityMessage, type ActivityState } from '@/composables/useActivity'
import { EVENT_KIND_ICON, EVENT_KIND_LABEL, type PiEventRow } from '@/utils/piEventKind'
import { loadReplay, type ReplayResult } from '@/composables/useReplay'
import type { PiMsg } from '@/composables/usePi'

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

/** A4 重放状态：加载中的旋钮、结果摘要与重建出的消息列表。 */
const replaying = ref(false)
const replayNote = ref('')
const replayError = ref(false)
const replayMessages = ref<PiMsg[]>([])

async function onReplay() {
  replaying.value = true
  replayError.value = false
  try {
    const res: ReplayResult = await loadReplay()
    replayMessages.value = res.messages
    if (res.error) {
      replayError.value = true
      replayNote.value = res.error
    } else {
      replayNote.value = `已从 journal 重建 ${res.messages.length} 条消息（共 ${res.eventCount} 条事件）`
    }
  } finally {
    replaying.value = false
  }
}

/** usage（治理五件套）：journal 聚合出的 token / 成本用量，面板打开时读一次。 */
interface UsageEntry {
  provider: string
  model: string
  calls: number
  totalTokens: number
  costTotal: number
}
interface UsageSummary {
  entries: UsageEntry[]
  totalCalls: number
  totalTokens: number
  totalCost: number
}

const usage = ref<UsageSummary | null>(null)
const usageError = ref('')

async function loadUsage() {
  usageError.value = ''
  usage.value = await invoke<UsageSummary>('governance_usage').catch((e) => {
    usageError.value = String(e)
    return null
  })
}

onMounted(loadUsage)

function fmtTokens(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}
function fmtCost(n: number): string {
  return n > 0 ? `$${n.toFixed(n >= 1 ? 2 : 4)}` : '$0'
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

    <!--
      usage（治理五件套）：内核按 message_end 上报的 provider/model/usage，
      由 Rust 侧从 journal 聚合。内核未启动时静默留空。
    -->
    <div v-if="usage && usage.totalCalls > 0" class="usage-zone">
      <div class="usage-head">
        <AppIcon name="activity" :size="12" />
        <span>用量</span>
        <b>{{ fmtTokens(usage.totalTokens) }} tokens · {{ fmtCost(usage.totalCost) }}</b>
        <button type="button" class="usage-refresh" title="重新统计" @click="loadUsage">
          <AppIcon name="refresh" :size="11" />
        </button>
      </div>
      <div v-for="e in usage.entries" :key="`${e.provider}/${e.model}`" class="usage-row">
        <span class="usage-model" :title="`${e.provider}/${e.model}`">{{ e.model }}</span>
        <span class="usage-num">{{ e.calls }} 次 · {{ fmtTokens(e.totalTokens) }} tk</span>
      </div>
    </div>

    <!--
      A4 崩溃重放：journal 落盘了完整事件流，内核崩掉后仍能从盘上重建转写。
      与实时通道共用同一套折算逻辑（applyEvent），重放结果不会与实况分叉。
    -->
    <div class="replay-zone">
      <button type="button" class="replay-btn" :disabled="replaying" @click="onReplay">
        <AppIcon name="refresh" :size="12" :class="{ spin: replaying }" />
        {{ replaying ? '重放中…' : '从 journal 重放会话' }}
      </button>
      <p v-if="replayNote" class="replay-note" :class="{ err: replayError }">{{ replayNote }}</p>
      <div v-if="replayMessages.length" class="replay-list">
        <p v-for="m in replayMessages" :key="m.id" class="replay-msg">
          <b>{{ m.tool ? `tool:${m.tool}` : m.role }}</b>
          <span>{{ m.text.slice(0, 160) || '（无正文）' }}</span>
        </p>
      </div>
    </div>

    <p class="note">
      事件由桥侧 <code>pi://event</code> 归一化而来；上方相位仍走流式状态的降级推断，
      细节以本列表为准。
    </p>
  </div>
</template>

<style src="./ActivityPanel.css" scoped></style>
