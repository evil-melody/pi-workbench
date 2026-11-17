<script setup lang="ts">
import { t } from '@/i18n'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppButton from '@/components/ui/AppButton.vue'
import { useCtxMenu } from '@/composables/useCtxMenu'
import { focusFirstMenuItem, onMenuKeydown } from '@/composables/useMenuKeys'
import { usePiEventsInjected } from '@/composables/usePiEvents'
import { activityMessage, type ActivityState } from '@/composables/useActivity'
import { statsSegments, type PiUsage } from '@/composables/piEvents'
import {
  codebaseIndexing,
  codebaseStatus,
  indexProjectCodebase,
} from '@/composables/useProject'
import { EVENT_KIND_ICON, eventKindLabel, eventDisplayLabel, type PiEventRow } from '@/utils/piEventKind'
import { loadReplay, type ReplayResult } from '@/composables/useReplay'
import { useRunFocus } from '@/composables/useRunFocus'
import { buildRunChains, createRunChainStore, runSummary, type RunChain } from '@/utils/runChain'
import RunGraph from './RunGraph.vue'
import type { PiMsg } from '@/composables/usePi'

const props = defineProps<{
  state: ActivityState
  running: boolean
  /** F10 从 composer 迁来：本会话用量 / 轮次 / 步数 / 活动项目 id。 */
  usage?: PiUsage | null
  turns?: number
  steps?: number
  projectId?: string | null
}>()

// 与「智能体浏览器」共用会话级缓冲；面板按需渲染，不另建订阅。
const stream = usePiEventsInjected()
const events = computed<PiEventRow[]>(() => stream?.events.value ?? [])
const stats = computed(() => stream?.stats.value ?? { total: 0, calls: 0, turns: 0, exits: 0 })

// 链路图：与消息里的「运行链路」入口共用一个焦点，点入口直接滚到本轮。
// 事件缓冲是定长环形的，图改走增量累加，避免旧行被淘汰时节点消失、整图缩水。
const chainStore = createRunChainStore()
const chains = computed<RunChain[]>(() => buildRunChains(chainStore.sync(events.value)).slice(-12))

/**
 * 旧轮次默认折成一行：12 张全景图平铺会把事件列表挤到 0 高，
 * 而用户多数时候只看最新一轮。展开过的轮次留在集合里，不被新一轮重置。
 */
const openRuns = ref(new Set<string>())
const latestRunId = computed(() => chains.value[chains.value.length - 1]?.runId ?? '')

/**
 * 结论区：终态 + 原因 + 计数。
 *
 * 之前只写「本轮已结束」+ 三个计数，用户读完仍不知道是成功、失败还是被中断；
 * 现在终态与原因都从最新一轮链路取（链路本身由 run_status / 中断标记累加），
 * 没有链路时退回状态机文案，不凭空判断。
 */
const latestChain = computed(() => chains.value[chains.value.length - 1] ?? null)
const verdict = computed<{ tone: string; title: string; reason: string } | null>(() => {
  const c = latestChain.value
  if (!c) return null
  const tools = c.stages.filter((s) => s.kind === 'tool')
  const failed = tools.filter((s) => s.status === 'failed')
  const bad = c.stages.find((s) => s.status === 'failed')
  const badAt = bad ? c.stages.indexOf(bad) + 1 : 0
  const totals = failed.length
    ? t('{0} 次工具，{1} 次失败', [tools.length, failed.length])
    : t('{0} 次工具，无失败', [tools.length])

  /*
   * 结束标记没落进事件流的兜底：链路停在 run，但会话已经收场（completed /
   * failed / interrupted）。改前这里会显示「进行中」，而同一块面板的
   * phase 文案写着「本轮已结束」——同一件事两个答案。收场后必须有终态；
   * 还在跑就返回 null，让状态机文案继续说「正在处理」。
   */
  const ended =
    props.state.phase === 'completed' ||
    props.state.phase === 'failed' ||
    props.state.phase === 'interrupted'
  let tone = c.status
  let lost = false
  if (c.status === 'run') {
    if (!ended) return null
    lost = true
    tone =
      props.state.phase === 'failed'
        ? 'failed'
        : props.state.phase === 'interrupted'
          ? 'cancelled'
          : 'ok'
  }

  const title =
    tone === 'ok'
      ? t('本轮完成')
      : tone === 'failed'
        ? t('本轮失败')
        : tone === 'cancelled'
          ? t('本轮已中断')
          : tone === 'blocked'
            ? t('本轮被拦下')
            : t('本轮超时')

  let reason: string
  if (tone === 'ok') {
    reason = lost
      ? t('未收到结束标记，按会话状态判定 · {0}', [totals])
      : failed.length
        ? t('{0}，其余步骤正常结束', [totals])
        : t('{0}，全部正常结束', [totals])
  } else if (tone === 'failed') {
    const why = (bad?.error || bad?.result || '').replace(/\s+/g, ' ').trim().slice(0, 90)
    reason = why
      ? t('{0} · {1}，停在第 {2} 步', [why, totals, badAt])
      : t('{0} 失败，链路在此时停止 · {1}', [bad?.label || bad?.kind || t('某一步'), totals])
    if (lost) reason = t('未收到结束标记，按会话状态判定 · {0}', [reason])
  } else if (tone === 'cancelled') {
    reason = t('由用户中断 · {0}', [totals])
    if (lost) reason = t('未收到结束标记，按会话状态判定 · {0}', [reason])
  } else if (tone === 'blocked') {
    const why = (bad?.error || '').replace(/\s+/g, ' ').trim()
    reason = why
      ? t('{0} · {1}', [why, totals])
      : t('等待审批未通过，后续步骤没有执行 · {0}', [totals])
  } else {
    reason = t('等待审批超时，后续步骤没有执行 · {0}', [totals])
  }
  return { tone, title, reason }
})

/** 原始事件默认关闭：步骤图已经覆盖「做了什么」，逐条事件只在排障时才有价值。 */
const rawOpen = ref(false)

function runOpen(c: RunChain): boolean {
  return c.runId === latestRunId.value || openRuns.value.has(c.runId)
}

function toggleRun(id: string) {
  const next = new Set(openRuns.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  openRuns.value = next
}

/** 折叠行摘要：与全图同源（runSummary），标题不另算一套。 */
function runLine(c: RunChain): string {
  const s = runSummary(c, Date.now())
  const ms = s.duration
  const dur = ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s` : `${Math.floor(ms / 60_000)}m`
  return `${s.parts.join(' → ')} · ${dur}`
}
const { focusRunId, focusSeq } = useRunFocus()

async function scrollToFocus() {
  if (!focusRunId.value) return
  await nextTick()
  const el = document.querySelector(`[data-run-id="${CSS.escape(focusRunId.value)}"]`)
  const box = document.querySelector<HTMLElement>('.activity-panel')
  if (!el || !box) return
  /*
   * 只滚面板自己。scrollIntoView 会连带滚所有可滚祖先：图区有 max-height 之后
   * 也是滚动容器，新轮次一到就被它滚掉 113px（实测图 top 421→308，整图往上跳）。
   */
  const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop
  box.scrollTo({ top: Math.max(0, top - 8), behavior: 'smooth' })
}

watch(focusSeq, scrollToFocus)
// 首次点入口时抽屉是刚展开的：ActivityPanel 挂载晚于 focusSeq 变化，
// 所以挂载后补一次定位，否则只会高亮、不滚到那一轮。
onMounted(() => {
  if (focusRunId.value) void scrollToFocus()
})

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

/** 步长：`at` 来自桥侧 `pi_ts`，配对成功就是真实间隔；不足 1s 不显示（0.3s 只会诱导盯着看）。 */
function stepDur(ms: number): string {
  if (ms < 1000) return ''
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
  return `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`
}

/**
 * 折叠态行模型：把 `tool_call` 与同工具名的 `tool_result` 顺序配对算出该步耗时。
 *
 * ponytail: 同名并发调用按「后到的调用配最近的返回」折算，行数不精确时右槽只是少显示
 * 一个时长，不会显示假数据；内核若补 call_id，升级路径就是用它配对。
 */
interface StreamRow {
  key: string
  ev: PiEventRow
  dur: string
}

/**
 * 列表行 = 一条事件，或一串连续 `lifecycle` 折成的聚合行（`agg` 装成员）。
 *
 * 内核每轮成对发 message_start/end、agent_start/end、entry_appended，
 * 平铺就是把轨迹面板刷成噪声墙——聚合才是这类事件的正确密度。
 * `ponytail:` 单条成员不聚合（没有「×N」可折），视图按 `quiet` 压暗。
 */
interface ListRow extends StreamRow {
  agg: StreamRow[] | null
}

const rows = computed<ListRow[]>(() => {
  const started = new Map<string, number>()
  const flat: StreamRow[] = events.value.map((ev, i) => {
    let dur = ''
    if (ev.kind === 'tool_call') started.set(ev.title, ev.at)
    else if (ev.kind === 'tool_result') {
      const t0 = started.get(ev.title)
      if (t0 !== undefined) {
        started.delete(ev.title)
        dur = stepDur(ev.at - t0)
      }
    }
    return { key: `${ev.at}-${i}`, ev, dur }
  })

  const out: ListRow[] = []
  let bucket: StreamRow[] = []
  const flush = () => {
    if (!bucket.length) return
    out.push({ ...bucket[0], agg: bucket.length > 1 ? bucket : null })
    bucket = []
  }
  for (const r of flat) {
    if (r.ev.kind === 'lifecycle') bucket.push(r)
    else {
      flush()
      out.push({ ...r, agg: null })
    }
  }
  flush()
  return out
})

/**
 * 事件名小标签：只在主文不是「人话」时补一行 mono。
 *
 * 工具行（`读取 a.ts`）和文本行自己就说清了在做什么，再贴 `tool_call` 是重复噪声；
 * 生命周期与真未识别的事件名是唯一有用的信息，所以留给它们。
 */
function showTypeTag(ev: PiEventRow): boolean {
  return ev.kind === 'lifecycle' || ev.kind === 'other'
}

/** 展开的行（原始 payload 只在这里出现）。 */
const openKeys = ref(new Set<string>())

function toggle(key: string) {
  const next = new Set(openKeys.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  openKeys.value = next
}

/** 面板头部「···」溢出菜单：重放与重算用量这类低频动作不再常驻占位。 */
const headEl = ref<HTMLElement | null>(null)
const menuEl = ref<HTMLElement | null>(null)
const { open: menuOpen, style: menuStyle, openAt, close } = useCtxMenu(200)

function openMenu() {
  if (!headEl.value) return
  openAt(headEl.value)
  void nextTick(() => focusFirstMenuItem(menuEl.value))
}

/** A4 重放状态：加载中的旋钮、结果摘要与重建出的消息列表。 */
const replaying = ref(false)
const replayNote = ref('')
const replayError = ref(false)
const replayMessages = ref<PiMsg[]>([])

async function onReplay() {
  if (replaying.value) return
  replaying.value = true
  replayError.value = false
  close()
  try {
    const res: ReplayResult = await loadReplay()
    replayMessages.value = res.messages
    if (res.error) {
      replayError.value = true
      replayNote.value = res.error
    } else {
      replayNote.value = t('已从 journal 重建 {0} 条消息（共 {1} 条事件）', [res.messages.length, res.eventCount])
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
  total_tokens: number
  cost_total: number
}
interface UsageSummary {
  entries: UsageEntry[]
  total_calls: number
  total_tokens: number
  total_cost: number
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

function refreshUsage() {
  close()
  loadUsage()
}

function fmtTokens(n: number): string {
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}
function fmtCost(n: number): string {
  return n > 0 ? `$${n.toFixed(n >= 1 ? 2 : 4)}` : '$0'
}

/* ── F10 从 composer 迁来：本会话统计 + 代码库索引状态 ───────────── */

/**
 * dsh 式统计段：轮次/步数 + token + 缓存命中 + 费用，缺数据的段不出现。
 *
 * 两处口径对齐：
 * - 步数：消息行没有工具 chip 时（历史会话/回放）为 0，但事件流里明明有调用，
 *   用事件调用数兜底，避免「图上 5 个工具、头部 0 步」。
 * - token：`usage.last` 可能上报全 0（provider 不回 usage），这时整段不画——
 *   底部「用量」读到的是 journal 聚合值，两个 0 并排放只会互相打脸。
 */
const segments = computed(() => {
  const u = props.usage ?? null
  const real = u && u.input + u.output + u.cacheRead + u.cacheWrite > 0 ? u : null
  // 轮次同样兜底：live 时消息折算可能尚未落 turn，事件流已有 1 轮 →
  // 上下文写「0 轮 · 7 步」、统计条写「1 轮次」的同屏打脸。
  return statsSegments(
    {
      turns: Math.max(props.turns ?? 0, stats.value.turns),
      steps: Math.max(props.steps ?? 0, stats.value.calls),
    },
    real,
  )
})

/** 只在「项目已经加载过索引状态」时出现，避免没项目时占位。 */
const codebaseVisible = computed(() => codebaseStatus.value !== null)
const codebaseClass = computed(() => {
  const s = codebaseStatus.value?.status
  if (codebaseIndexing.value) return 'indexing'
  if (s === 'error') return 'error'
  if (s === 'indexed') return 'ready'
  return 'idle'
})

const shortError = computed(() => {
  const e = codebaseStatus.value?.error
  if (!e) return ''
  return e.length > 60 ? `${e.slice(0, 57)}…` : e
})

/** 索引已耗时（秒）：没有刻度用户只能干等；显示 Ns 后「多久算异常」一目了然。 */
const indexElapsed = ref(0)
let indexTimer: ReturnType<typeof setInterval> | null = null
watch(codebaseIndexing, (on) => {
  if (on) {
    indexElapsed.value = 0
    indexTimer = setInterval(() => indexElapsed.value++, 1000)
  } else if (indexTimer) {
    clearInterval(indexTimer)
    indexTimer = null
  }
})
onUnmounted(() => indexTimer && clearInterval(indexTimer))

const codebaseText = computed(() => {
  const s = codebaseStatus.value
  if (codebaseIndexing.value) return t('索引代码库中… {0}s（全仓首次约 10-60s）', [indexElapsed.value])
  if (s?.status === 'indexed') return t('已索引 {0} 节点 / {1} 边', [s.nodes, s.edges])
  if (s?.status === 'error') return t('索引失败：{0}', [shortError.value])
  return t('代码库未索引')
})

/** 索引中不给按钮（点了也没用）；其余状态都给一条明确的下一步。 */
const codebaseAction = computed(() => {
  if (codebaseIndexing.value) return null
  const s = codebaseStatus.value?.status
  return s === 'indexed' ? t('重建') : s === 'error' ? t('重试') : t('索引')
})

/** 手动（重新）索引：仅在绑定了活动项目时可用。 */
async function reindex() {
  if (!props.projectId) return
  await indexProjectCodebase(props.projectId).catch(() => {})
}
</script>

<template>
  <div class="activity-panel">
    <div class="panel-head">
      <AppIcon name="activity" :size="14" />
      <span>{{ t('智能体轨迹') }}</span>
      <span class="panel-count" :title="t('{0} / {1} 条事件', [events.length, stats.total])">{{ events.length }}</span>
      <AppButton
        ref="headEl"
        variant="icon"
        class="panel-menu-btn"
        :title="t('更多操作')"
        :aria-label="t('更多操作')"
        aria-haspopup="menu"
        :aria-expanded="menuOpen"
        @click="openMenu"
      >
        <AppIcon name="more-horizontal" :size="14" />
      </AppButton>
    </div>

    <div class="status-card">
      <div class="status-row">
        <span class="dot" :class="verdict ? `dot-v-${verdict.tone}` : `dot-${props.state.phase}`" />
        <strong>{{ verdict ? verdict.title : activityMessage(props.state) }}</strong>
      </div>
      <p v-if="verdict" class="status-reason">{{ verdict.reason }}</p>
      <div v-if="props.state.tool || props.state.skill" class="meta">
        <span v-if="props.state.tool" class="meta-chip">{{ props.state.tool }}</span>
        <span v-if="props.state.skill" class="meta-chip">{{ props.state.skill }}</span>
      </div>
    </div>

    <!-- 全为 0 时不画统计条：三个 0 不提供信息，只把事件列表往下推 52px。 -->
    <div v-if="stats.calls || stats.turns || stats.exits" class="stat-bar" role="group" :aria-label="t('本会话事件统计')">
      <span class="stat"><b>{{ stats.calls }}</b><i>{{ t('调用') }}</i></span>
      <span class="stat"><b>{{ stats.turns }}</b><i>{{ t('轮次') }}</i></span>
      <span class="stat"><b>{{ stats.exits }}</b><i>{{ t('退出') }}</i></span>
    </div>

    <!--
      F10：本会话统计与代码库索引状态从 composer 行迁来——输入框下面只留
      附件 / steer / 中断 / 发送，这些「过程信息」归轨迹面板的上下文区。
    -->
    <div v-if="segments.length || codebaseVisible" class="usage-zone ctx-zone">
      <p v-for="(s, i) in segments" :key="`seg-${i}`" class="ctx-line">{{ s }}</p>
      <p v-if="codebaseVisible" class="ctx-line" :class="codebaseClass">
        <AppIcon name="database" :size="11" />
        <span class="ctx-text">{{ codebaseText }}</span>
        <AppButton
          v-if="codebaseAction"
          variant="text"
          class="ctx-act"
          :title="t('{0}当前项目代码库', [codebaseAction])"
          @click="reindex"
        >
          <AppIcon name="refresh" :size="11" />
          <span>{{ codebaseAction }}</span>
        </AppButton>
      </p>
    </div>

    <!-- 运行链路全景：最新一轮展开；旧轮次默认一行摘要，点开再铺图。 -->
    <div v-if="chains.length" class="run-graphs">
      <template v-for="(c, i) in chains" :key="c.runId">
        <RunGraph
          v-if="runOpen(c)"
          :chain="c"
          :data-run-id="c.runId"
          :class="{ 'is-focused': c.runId === focusRunId }"
        />
        <button
          v-else
          type="button"
          class="run-fold"
          :class="{ 'is-focused': c.runId === focusRunId }"
          :data-run-id="c.runId"
          :aria-expanded="false"
          :title="c.prompt"
          @click="toggleRun(c.runId)"
        >
          <span class="rf-turn">{{ t('第 {0} 轮', [i + 1]) }}</span>
          <span class="rf-line">{{ runLine(c) }}</span>
          <AppIcon name="chevron-right" :size="11" class="rf-caret" />
        </button>
      </template>
    </div>
    <!-- 没有事件时只留下面 event-list 的一条空态：两个空块叠着说同一件事。 -->
    <p v-else-if="events.length" class="run-graphs-empty">{{ t('还没有运行链路。发起一次请求后，这里会长出节点图。') }}</p>

    <p v-if="!events.length" class="raw-empty">{{ t('尚无事件。发起一轮对话后，内核事件会在这里按时间排列。') }}</p>
    <!-- 原始事件默认关闭：上面的步骤图已经回答「做了什么」，逐条事件只在排障时展开。 -->
    <template v-else>
      <button type="button" class="raw-toggle" :aria-expanded="rawOpen" @click="rawOpen = !rawOpen">
        <AppIcon name="chevron-right" :size="11" class="rt-caret" :class="{ open: rawOpen }" />
        <span>{{ t('原始事件') }}</span>
        <span class="rt-count">{{ events.length }}</span>
      </button>

      <div v-if="rawOpen" ref="listEl" class="event-list" @scroll="onScroll">
      <!--
        两条分支共用同一套行解剖（event-head / ic / main / slot / caret）：
        聚合行只是把「一步」换成「N 步」，样式与展开逻辑不该重抄一遍。
      -->
      <template v-for="r in rows" :key="r.key">
        <div v-if="r.agg" class="event-item evt-agg" :class="{ open: openKeys.has(r.key) }">
          <AppButton variant="menu-item" class="event-head" :aria-expanded="openKeys.has(r.key)" @click="toggle(r.key)">
            <span class="event-ic">
              <AppIcon name="clock" :size="13" />
            </span>
            <span class="event-main">
              <span class="event-name"><span class="evt-text">{{ t('系统事件 ×{0}', [r.agg.length]) }}</span></span>
            </span>
            <span class="event-slot">
              <span class="event-time">{{ clock(r.ev.at) }}</span>
              <AppIcon name="chevron-right" :size="11" class="event-caret" />
            </span>
          </AppButton>
          <div v-if="openKeys.has(r.key)" class="evt-agg-body">
            <p v-for="it in r.agg" :key="it.key" class="evt-agg-row">
              <span class="evt-agg-name">{{ eventDisplayLabel(it.ev) }}</span>
              <span v-if="it.ev.type" class="evt-type-tag">{{ it.ev.type }}</span>
              <span class="event-time">{{ clock(it.ev.at) }}</span>
            </p>
          </div>
        </div>

        <div v-else class="event-item" :class="{ open: openKeys.has(r.key), quiet: r.ev.kind === 'lifecycle' }">
          <AppButton variant="menu-item" class="event-head" :aria-expanded="openKeys.has(r.key)" @click="toggle(r.key)">
            <span class="event-ic">
              <AppIcon :name="EVENT_KIND_ICON[r.ev.kind]" :size="13" />
            </span>
            <span class="event-main">
              <span class="event-name">
                <span class="evt-text">{{ eventDisplayLabel(r.ev) }}</span>
                <span v-if="showTypeTag(r.ev)" class="evt-type-tag">{{ r.ev.type }}</span>
              </span>
              <span v-if="r.ev.result" class="event-desc">{{ r.ev.result }}</span>
            </span>
            <span class="event-slot">
              <span v-if="r.dur" class="event-dur">{{ r.dur }}</span>
              <span class="event-time">{{ clock(r.ev.at) }}</span>
              <AppIcon name="chevron-right" :size="11" class="event-caret" />
            </span>
          </AppButton>
          <div v-if="openKeys.has(r.key)" class="event-body">
            <p class="event-meta">
              <span class="event-kind">{{ eventKindLabel(r.ev.kind) }}</span>
              <span v-if="r.ev.type" class="event-type">{{ r.ev.type }}</span>
              <span v-if="r.ev.fieldsCount">{{ t('{0} 字段', [r.ev.fieldsCount]) }}</span>
            </p>
            <pre v-if="r.ev.payload" class="event-payload">{{ r.ev.payload }}</pre>
            <p v-else class="usage-empty">{{ t('这条是面板本地记的笔记，内核没有原始记录。') }}</p>
          </div>
        </div>
      </template>
      </div>
    </template>

    <!--
      usage（治理五件套）：内核按 message_end 上报的 provider/model/usage，
      由 Rust 侧从 journal 聚合。内核未启动时给出诚实空态，不放假数字。
    -->
    <div class="usage-zone">
      <template v-if="usage && usage.total_calls > 0">
        <div class="usage-head">
          <AppIcon name="activity" :size="12" />
          <span>{{ t('用量') }}</span>
          <b>{{ fmtTokens(usage.total_tokens) }} tokens · {{ fmtCost(usage.total_cost) }}</b>
        </div>
        <div v-for="e in usage.entries" :key="`${e.provider}/${e.model}`" class="usage-row">
          <span class="usage-model" :title="`${e.provider}/${e.model}`">{{ e.model }}</span>
          <span class="usage-num">{{ t('{0} 次 · {1} tk', [e.calls, fmtTokens(e.total_tokens)]) }}</span>
        </div>
      </template>
      <p v-else class="usage-empty">{{ usageError || t('还没有用量数据') }}</p>
    </div>

    <!--
      A4 崩溃重放：journal 落盘了完整事件流，内核崩掉后仍能从盘上重建转写。
      与实时通道共用同一套折算逻辑（applyEvent），重放结果不会与实况分叉。
      入口在面板头部「···」菜单，结果就地显示。
    -->
    <div v-if="replayNote || replayMessages.length" class="replay-zone">
      <p v-if="replayNote" class="replay-note" :class="{ err: replayError }">{{ replayNote }}</p>
      <div v-if="replayMessages.length" class="replay-list">
        <p v-for="m in replayMessages" :key="m.id" class="replay-msg">
          <b>{{ m.tool ? `tool:${m.tool}` : m.role }}</b>
          <span>{{ m.text.slice(0, 160) || t('（无正文）') }}</span>
        </p>
      </div>
    </div>

    <Teleport to="body">
      <div v-if="menuOpen" ref="menuEl" class="ctx-menu" :style="menuStyle" role="menu" @keydown="onMenuKeydown">
        <AppButton
          variant="menu-item"
          class="ctx-menu-item"
          role="menuitem"
          @click="onReplay"
        >
          <AppIcon name="history" :size="15" />
          <span>{{ replaying ? t('重放中…') : t('从 journal 重放会话') }}</span>
        </AppButton>
        <div class="ctx-menu-sep" role="separator"></div>
        <AppButton variant="menu-item" class="ctx-menu-item" role="menuitem" @click="refreshUsage">
          <AppIcon name="refresh" :size="15" />
          <span>{{ t('重新统计用量') }}</span>
        </AppButton>
      </div>
    </Teleport>
  </div>
</template>

<style src="./ActivityPanel.css" scoped></style>
<style src="@/components/ui/ContextMenu.css" scoped></style>
