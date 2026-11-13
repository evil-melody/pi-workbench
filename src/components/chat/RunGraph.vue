<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
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
    clipTitle: clip(r.title, w - 24, 13, 600),
  }))
})

/** 耗时文字按帧取值：只改文本节点，不动 `rows` / `nodes` 的缓存几何。 */
function clipMeta(r: { stage: RunStage; width: number }): string {
  return clip(stageMeta(r.stage, now.value), r.width - 24, 12, 400, true)
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

function select(stage: RunStage) {
  selectedKey.value = selectedKey.value === stage.key ? null : stage.key
}

function fmt(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return `${m}m${String(s).padStart(2, '0')}s`
}

function stageTitle(stage: RunStage): string {
  if (stage.kind === 'tool') return stage.label ?? t('工具')
  return stageLabel(stage)
}

function stageMeta(stage: RunStage, at: number): string {
  const bits = [fmt(stageElapsed(stage, at))]
  if ((stage.kind === 'kernel' || stage.kind === 'expert') && stage.detail) bits.push(stage.detail)
  if (stage.retries) bits.push(t('重试 {0} 次', [stage.retries]))
  if (stage.status !== 'ok') bits.push(runStatusText(stage.status))
  if (isLongStage(stage, at)) bits[0] = t('已耗时 {0}', [bits[0]])
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
            <text class="rg-lane" :x="NODE_X" :y="row.y + 16">{{ laneName(row.lane) }}</text>
            <line class="rg-lane-rule" :x1="NODE_X" :x2="width - 8" :y1="row.y + row.h - 6" :y2="row.y + row.h - 6" />
          </g>
          <g v-else-if="row.type === 'handoff'" class="rg-handoff">
            <line class="rg-rail is-handoff" :x1="RAIL_X" :x2="RAIL_X" :y1="row.y" :y2="row.y + row.h" />
            <text class="rg-handoff-text" :x="NODE_X" :y="row.y + 17">
              {{ t('交接：{0} → {1}', [laneName(row.from), laneName(row.to)]) }}
            </text>
          </g>
        </template>

        <g
          v-for="n in nodes"
          :key="n.stage.key"
          class="rg-node"
          :class="[`is-${n.stage.status}`, selectedKey === n.stage.key && 'is-selected', isLongStage(n.stage, now) && 'is-long']"
          role="button"
          tabindex="0"
          @click="select(n.stage)"
          @keydown.enter="select(n.stage)"
          @keydown.space.prevent="select(n.stage)"
        >
          <line class="rg-stub" :x1="RAIL_X" :x2="n.x" :y1="n.y + NODE_H / 2" :y2="n.y + NODE_H / 2" />
          <path class="rg-arrow" :d="`M ${n.x - 4} ${n.y + NODE_H / 2 - 3} L ${n.x} ${n.y + NODE_H / 2} L ${n.x - 4} ${n.y + NODE_H / 2 + 3}`" />
          <rect class="rg-box" :x="n.x" :y="n.y" :width="n.width" :height="NODE_H" rx="6" />
          <rect class="rg-bar" :x="n.x" :y="n.y + 9" width="2" :height="NODE_H - 18" rx="1" />
          <text class="rg-node-title" :x="n.x + 12" :y="n.y + 21">{{ n.clipTitle }}</text>
          <text class="rg-node-meta" :x="n.x + 12" :y="n.y + 40">{{ clipMeta(n) }}</text>
        </g>
      </svg>
    </div>

    <div v-if="selectedStage" class="rg-detail">
      <div class="rg-detail-head">
        <span class="rg-detail-title">{{ stageLabel(selectedStage) }}</span>
        <span class="rg-detail-meta">{{ fmt(stageElapsed(selectedStage, now)) }} · {{ runStatusText(selectedStage.status) }}</span>
      </div>
      <dl class="rg-detail-body">
        <dt>{{ t('输入') }}</dt>
        <dd>{{ selectedStage.detail || '—' }}</dd>
        <dt>{{ t('输出') }}</dt>
        <dd>{{ selectedStage.result || '—' }}</dd>
        <template v-if="selectedStage.error">
          <dt>{{ t('失败') }}</dt>
          <dd class="is-error">{{ selectedStage.error }}</dd>
        </template>
        <dt>{{ t('原始事件') }}</dt>
        <dd><pre class="rg-raw">{{ selectedStage.raw || '—' }}</pre></dd>
      </dl>
    </div>
  </section>
</template>

<style src="./RunGraph.css" scoped></style>
