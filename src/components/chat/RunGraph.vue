<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '@/i18n'
import {
  isLongStage,
  runStatusText,
  runSummary,
  stageElapsed,
  stageLabel,
  type RunChain,
  type RunStage,
} from '@/utils/runChain'

/**
 * 运行链路全景图：节点 + 连线，按角色纵向分道。
 *
 * 为什么是纵向分道而不是左右泳道：轨迹抽屉只有 ~320px，390 窄屏也放不下并排成员，
 * 并排必然出现节点重叠或连线穿过节点。这里用「左侧时间轴 + 右侧节点卡」：
 * 连线只走节点左侧的独立轨道，任何宽度下都不会压到节点。
 */
const props = defineProps<{ chain: RunChain; compact?: boolean }>()

/** 侧栏宽度：轨道 x 与节点起点，窄屏下也不压缩。 */
const RAIL_X = 12
const NODE_X = 30
const NODE_H = 50
const ROW_GAP = 8
const LANE_H = 24
const HANDOFF_H = 26

const host = ref<HTMLElement | null>(null)
const width = ref(320)
const trunk = ref(false)
const selectedKey = ref<string | null>(null)
const now = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined

const summary = computed(() => runSummary(props.chain, now.value))
const summaryText = computed(() => summary.value.parts.join(' → '))
const durationText = computed(() => fmt(summary.value.duration))

const selectedStage = computed(
  () => props.chain.stages.find((s) => s.key === selectedKey.value) ?? null,
)

const detailEl = ref<HTMLElement | null>(null)

/**
 * 展开体的数据来源：`raw` 是内核原始 payload（缩进 JSON，≤6000 字），
 * 比 `stage.detail`（100 字摘要）与 `stage.result`（300 字摘要）全。
 * 解析失败就退回摘要，不把整块细节丢掉。
 */
function parsedRaw(stage: RunStage): Record<string, unknown> | null {
  if (!stage.raw) return null
  try {
    const v = JSON.parse(stage.raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function pretty(v: unknown): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

/** 工具返回正文：内核固定形状 `result.content[].text`。 */
function toolStdout(raw: Record<string, unknown> | null): string {
  const result = raw?.result
  if (!result || typeof result !== 'object') return ''
  const content = (result as Record<string, unknown>).content
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => (c && typeof c === 'object' ? String((c as Record<string, unknown>).text ?? '') : ''))
    .filter(Boolean)
    .join('\n')
}

/** 没有内容时写清原因：空白和 `—` 都读不出「是没数据，还是没渲染出来」。 */
function emptyWhy(stage: RunStage, side: 'input' | 'output'): string {
  if (side === 'input') {
    return stage.kind === 'tool'
      ? t('内核没有上报该工具的入参。')
      : t('{0}没有入参。', [stageLabel(stage)])
  }
  if (stage.kind === 'tool') return t('本步无输出：内核没有回传 stdout/stderr。')
  return t('{0}没有输出。', [stageLabel(stage)])
}

/** 展开内容：工具段优先读 raw 里的完整参数与 stdout，其余段用环节摘要。 */
const detail = computed(() => {
  const s = selectedStage.value
  if (!s) return null
  const raw = parsedRaw(s)
  const input = (s.kind === 'tool' ? pretty(raw?.args) || s.detail : s.detail) || ''
  const output = (s.kind === 'tool' ? toolStdout(raw) || s.result : s.result) || ''
  return {
    input,
    inputWhy: input ? '' : emptyWhy(s, 'input'),
    output,
    outputWhy: output ? '' : emptyWhy(s, 'output'),
    error: s.error ?? '',
    raw: s.raw ?? '',
  }
})

/** 主干视图：折叠成功的工具细节，异常环节一个都不藏。 */
const visibleStages = computed(() =>
  props.chain.stages.filter((s) => !trunk.value || s.kind !== 'tool' || s.status !== 'ok'),
)

const hasOpen = computed(
  () => props.chain.status === 'run' || props.chain.stages.some((s) => s.endedAt == null),
)

type Row =
  | { type: 'lane'; id: string; lane: string; y: number; h: number }
  | { type: 'handoff'; id: string; from: string; to: string; y: number; h: number }
  | { type: 'node'; id: string; stage: RunStage; lane: string | null; y: number; h: number; title: string }

function isBackbone(stage: RunStage): boolean {
  return (
    stage.kind === 'request' ||
    stage.kind === 'kernel' ||
    stage.kind === 'expert' ||
    stage.kind === 'end'
  )
}

/**
 * 行几何只依赖节点集合，不读 `now`：每秒的耗时刷新只该换文字，
 * 不能重算坐标，否则整张 SVG（长任务能到上万像素高）每秒都要重排。
 */
const rows = computed<Row[]>(() => {
  const out: Row[] = []
  let lastLane: string | null = null
  for (const stage of visibleStages.value) {
    const lane = isBackbone(stage) ? null : stage.agentId || 'main'
    if (lane && lane !== lastLane) {
      // key 跟着触发它的阶段走：上方插节点时不会换 key，元素得以复用而不是重建。
      if (lastLane && lastLane !== lane) {
        out.push({ type: 'handoff', id: `handoff:${stage.key}`, from: lastLane, to: lane, y: 0, h: HANDOFF_H })
      }
      out.push({ type: 'lane', id: `lane:${stage.key}`, lane, y: 0, h: LANE_H })
    }
    out.push({
      type: 'node',
      id: `node:${stage.key}`,
      stage,
      lane,
      y: 0,
      h: NODE_H,
      title: stageTitle(stage),
    })
    lastLane = lane
  }
  let y = 0
  for (const row of out) {
    row.y = y
    row.h = row.type === 'node' ? NODE_H : row.type === 'lane' ? LANE_H : HANDOFF_H
    y += row.h + ROW_GAP
  }
  return out
})

const nodeRows = computed(() => rows.value.filter((r): r is Extract<Row, { type: 'node' }> => r.type === 'node'))

const nodes = computed(() => {
  const w = Math.max(160, width.value - NODE_X - 8)
  return nodeRows.value.map((r) => ({
    ...r,
    x: NODE_X,
    width: w,
    clipTitle: clip(r.title, w - 24, 12, 600),
  }))
})

/** 副行文字与耗时各占一侧：耗时固定贴右，不再和参数抢同一行。 */
const DUR_W = 54

/** 副行按帧取值：只改文本节点，不动 `rows` / `nodes` 的缓存几何。 */
function clipMeta(r: { stage: RunStage; width: number }): string {
  return clip(stageSub(r.stage, now.value), r.width - 24 - DUR_W, 11, 400)
}

function durText(r: { stage: RunStage }): string {
  return fmt(stageElapsed(r.stage, now.value))
}

const height = computed(() => {
  const last = rows.value[rows.value.length - 1]
  return last ? last.y + last.h + 8 : 24
})

/** 轨道只画到首尾节点中心，避免在空白处多出一截线。 */
const rail = computed(() => {
  const list = nodes.value
  if (!list.length) return null
  return { x: RAIL_X, y1: list[0].y + NODE_H / 2, y2: list[list.length - 1].y + NODE_H / 2 }
})

async function select(stage: RunStage) {
  selectedKey.value = selectedKey.value === stage.key ? null : stage.key
  if (!selectedKey.value) return
  await nextTick()
  // 详情块在整图下方，长链路里不滚过去的话，点完节点等于什么都没发生。
  detailEl.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}

function fmt(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m${String(s).padStart(2, '0')}s`
}

/** 工具标签形如 `bash · find ...`：拆成「工具名」与「在干什么」，别让参数挤在标题里被砍。 */
function toolParts(stage: RunStage): [string, string] {
  const label = stage.label ?? t('工具')
  const i = label.indexOf(' · ')
  return i < 0 ? [label, ''] : [label.slice(0, i), label.slice(i + 3)]
}

function stageTitle(stage: RunStage): string {
  return stage.kind === 'tool' ? toolParts(stage)[0] : stageLabel(stage)
}

/** 副行只说「这一步干了什么 / 出了什么问题」，耗时单独贴右。 */
function stageSub(stage: RunStage, at: number): string {
  const bits: string[] = []
  if (stage.status !== 'ok') bits.push(runStatusText(stage.status))
  if (stage.retries) bits.push(t('重试 {0} 次', [stage.retries]))
  if (isLongStage(stage, at)) bits.push(t('已耗时 {0}', [fmt(stageElapsed(stage, at))]))
  const body =
    stage.kind === 'tool' ? toolParts(stage)[1] || stage.detail : stage.kind === 'model' ? stage.result : stage.detail || stage.result
  if (body) bits.push(body)
  return bits.join(' · ')
}

/**
 * 已知的专家角色才有中文头衔；未知 agentId 原样显示，不编身份。
 */
function laneName(id: string): string {
  const table: Record<string, string> = {
    main: t('主理人'),
    'code-crew-team-lead': 'Horizon',
    'code-investigator': 'Vera',
    'code-implementer': 'Max',
    'code-test-writer': 'Tess',
    'code-reviewer': 'Ray',
  }
  return table[id] ?? id
}

/**
 * 轨道名与交接文案同样要按图宽截断。
 * 小视口（抽屉 320px）下长 agentId 会画到 SVG 之外，被 .rg-host 直接硬切，
 * 连省略号都没有；这里用与节点标题同一套 canvas 量宽后再截。
 */
const laneMax = computed(() => Math.max(48, width.value - NODE_X - 12))

function laneText(id: string): string {
  return clip(laneName(id), laneMax.value, 11, 600)
}

function handoffText(from: string, to: string): string {
  return clip(t('交接：{0} → {1}', [laneName(from), laneName(to)]), laneMax.value, 11, 400)
}

let measureCtx: CanvasRenderingContext2D | null = null
const FONT_SANS = 'ui-sans-serif, -apple-system, "PingFang SC", sans-serif'
const FONT_MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

/** 用 canvas 量真实字宽再截断：SVG 里字被裁掉是最难发现的视觉缺陷（mono 比 sans 宽，必须分开量）。 */
function clip(s: string, max: number, size: number, weight: number, mono = false): string {
  if (max <= 0) return ''
  if (!measureCtx && typeof document !== 'undefined') {
    measureCtx = document.createElement('canvas').getContext('2d')
  }
  if (!measureCtx) return s
  measureCtx.font = `${weight} ${size}px ${mono ? FONT_MONO : FONT_SANS}`
  if (measureCtx.measureText(s).width <= max) return s
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (measureCtx.measureText(`${s.slice(0, mid)}…`).width <= max) lo = mid
    else hi = mid - 1
  }
  return `${s.slice(0, lo)}…`
}

function syncWidth() {
  const el = host.value
  if (!el) return
  const w = Math.max(220, Math.floor(el.clientWidth))
  // ResizeObserver 每次回调都写 ref 会连带重算整图几何；值没变就别动。
  if (w !== width.value) width.value = w
}

watch(hasOpen, (open) => {
  if (timer) clearInterval(timer)
  timer = undefined
  if (!open) return
  timer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
}, { immediate: true })

onMounted(() => {
  syncWidth()
  const el = host.value
  if (el && typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(syncWidth)
    ro.observe(el)
    unmounts.push(() => ro.disconnect())
  }
})

const unmounts: Array<() => void> = []
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
  for (const fn of unmounts) fn()
})
</script>

<template>
  <section class="run-graph" :class="{ 'is-compact': compact }">
    <header class="rg-head">
      <span class="rg-title-main">{{ t('运行链路') }}</span>
      <span class="rg-summary">{{ summaryText }}</span>
      <span class="rg-duration">{{ durationText }}</span>
      <button class="rg-trunk" type="button" @click="trunk = !trunk">
        {{ trunk ? t('看全部') : t('只看主干') }}
      </button>
    </header>

    <p v-if="chain.degraded" class="rg-note">
      {{ t('该请求来自没有链路信封的旧记录，按轮次聚合展示，环节耗时不可用。') }}
    </p>

    <div ref="host" class="rg-host">
      <svg class="rg-svg" :width="width" :height="height" :viewBox="`0 0 ${width} ${height}`" role="img" :aria-label="t('运行链路')">
        <line v-if="rail" class="rg-rail" :x1="rail.x" :y1="rail.y1" :x2="rail.x" :y2="rail.y2" />

        <template v-for="row in rows" :key="row.type === 'node' ? row.stage.key : row.id">
          <g v-if="row.type === 'lane'" class="rg-lane-row">
            <text class="rg-lane" :x="NODE_X" :y="row.y + 16">{{ laneText(row.lane) }}</text>
            <line class="rg-lane-rule" :x1="NODE_X" :x2="width - 8" :y1="row.y + row.h - 6" :y2="row.y + row.h - 6" />
          </g>
          <g v-else-if="row.type === 'handoff'" class="rg-handoff">
            <line class="rg-rail is-handoff" :x1="RAIL_X" :x2="RAIL_X" :y1="row.y" :y2="row.y + row.h" />
            <text class="rg-handoff-text" :x="NODE_X" :y="row.y + 17">
              {{ handoffText(row.from, row.to) }}
            </text>
          </g>
        </template>

        <g
          v-for="n in nodes"
          :key="n.stage.key"
          class="rg-node"
          :class="[
            `is-${n.stage.status}`,
            isBackbone(n.stage) ? 'is-backbone' : `is-${n.stage.kind}`,
            selectedKey === n.stage.key && 'is-selected',
            isLongStage(n.stage, now) && 'is-long',
          ]"
          role="button"
          tabindex="0"
          :aria-expanded="selectedKey === n.stage.key"
          @click="select(n.stage)"
          @keydown.enter="select(n.stage)"
          @keydown.space.prevent="select(n.stage)"
        >
          <line class="rg-stub" :x1="RAIL_X" :x2="n.x" :y1="n.y + NODE_H / 2" :y2="n.y + NODE_H / 2" />
          <path class="rg-arrow" :d="`M ${n.x - 4} ${n.y + NODE_H / 2 - 3} L ${n.x} ${n.y + NODE_H / 2} L ${n.x - 4} ${n.y + NODE_H / 2 + 3}`" />
          <rect class="rg-box" :x="n.x" :y="n.y" :width="n.width" :height="NODE_H" rx="6" />
          <rect class="rg-bar" :x="n.x" :y="n.y + 9" width="2" :height="NODE_H - 18" rx="1" />
          <text class="rg-node-title" :x="n.x + 12" :y="n.y + 21">{{ n.clipTitle }}</text>
          <text class="rg-node-meta" :x="n.x + 12" :y="n.y + 39">{{ clipMeta(n) }}</text>
          <text class="rg-node-dur" :x="n.x + n.width - 12" :y="n.y + 39" text-anchor="end">{{ durText(n) }}</text>
        </g>
      </svg>
    </div>

    <div v-if="selectedStage && detail" ref="detailEl" class="rg-detail">
      <div class="rg-detail-head">
        <span class="rg-detail-title">{{ stageTitle(selectedStage) }}</span>
        <span class="rg-detail-meta">{{ fmt(stageElapsed(selectedStage, now)) }} · {{ runStatusText(selectedStage.status) }}</span>
      </div>
      <dl class="rg-detail-body">
        <dt>{{ t('输入') }}</dt>
        <dd v-if="detail.input"><pre class="rg-pre">{{ detail.input }}</pre></dd>
        <dd v-else class="is-why">{{ detail.inputWhy }}</dd>
        <dt>{{ t('输出') }}</dt>
        <dd v-if="detail.output"><pre class="rg-pre">{{ detail.output }}</pre></dd>
        <dd v-else class="is-why">{{ detail.outputWhy }}</dd>
        <template v-if="detail.error">
          <dt>{{ t('失败') }}</dt>
          <dd class="is-error">{{ detail.error }}</dd>
        </template>
        <dt>{{ t('原始事件') }}</dt>
        <dd v-if="detail.raw"><pre class="rg-raw">{{ detail.raw }}</pre></dd>
        <dd v-else class="is-why">{{ t('该步没有原始事件记录。') }}</dd>
      </dl>
    </div>
  </section>
</template>

<style src="./RunGraph.css" scoped></style>
