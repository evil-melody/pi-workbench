<script setup lang="ts">
import { t } from '@/i18n'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { marked } from 'marked'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppButton from '@/components/ui/AppButton.vue'
import ArtifactCard from './ArtifactCard.vue'
import ArtifactPreview from './ArtifactPreview.vue'
import CollapsibleRow from './CollapsibleRow.vue'
import MessageAttachments from './MessageAttachments.vue'
import { usePiEventsInjected } from '@/composables/usePiEvents'
import { useRunFocus } from '@/composables/useRunFocus'
import { buildRunChains, runSummary, type RunChain as RunChainModel } from '@/utils/runChain'
import type { Artifact } from '@/composables/useArtifacts'
import { fmtCost, type PiUsage } from '@/composables/piEvents'
import { changeDelta, diffLines, fileName, type PiFileChange } from '@/utils/fileChanges'
import { fmtClock } from '@/utils/timeAgo'
import {
  clipLines,
  firstLine,
  relativizeToCwd,
  splitExitCode,
  summarizeToolCall,
  toolArgsBlocks,
  toolRowState,
  type ToolRowSummary,
} from '@/utils/toolSummary'

const props = defineProps<{
  messages: any[]
  streaming: boolean
  /** 本轮由用户点「中断」收场（ChatView 在 abort 成功后置位，下轮流式清零）。 */
  interrupted?: boolean
  artifacts: Record<string, Artifact[]>
  root: string
}>()

const emit = defineEmits<{
  rewind: [msg: { id: string; turnSeq?: number; text: string }]
  'plan-execute': [msg: any]
  'plan-revise': [msg: any]
}>()

const open = ref<Artifact | null>(null)
/** G2：已展开 diff 的文件改动 id（同一个 turn 里多个文件可同时展开）。 */
const openFiles = ref(new Set<string>())

function toggleFile(id: string) {
  const next = new Set(openFiles.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  openFiles.value = next
}

/**
 * 首字未到之前的等待态：已发出、内核还没回任何内容。
 *
 * 没有它，用户发完消息看到的就是「一条孤零零的提问 + 什么都没有」，
 * 无从判断是模型在想、还是根本没送出去。
 */
const waiting = computed(() => {
  if (!props.streaming) return false
  const last = props.messages[props.messages.length - 1]
  // 文件改动进行中（工具执行期）不算「等模型」：改动块本身就是进度。
  return !(last && last.role === 'assistant' && (last.text || last.fileChanges?.length))
})

/**
 * 空块判定：assistant 消息没有任何可展示内容（无思考/文本/工具名/文件改动/
 * 计划/附件/用量/产物）就不并进 turn——journal 回放和流式折算都可能产生
 * 这种空壳，逐块渲染就是用户截图里「一个个空 Pi 头像」的来源。
 */
function isEmptyRow(m: any): boolean {
  if (m.role !== 'assistant') return false
  // 正文只 trim 后判空：流式折算 / 回放常产出纯空白的 assistant 壳消息，
  // 不 trim 就会漏过、渲染成一个个空蓝圈（用户截图里「一排头像」的来源）。
  const text = typeof m.text === 'string' ? m.text.trim() : ''
  return (
    !text &&
    !m.reasoning &&
    !m.tool &&
    !m.plan &&
    !m.usage &&
    !m.fileChanges?.length &&
    !m.attachments?.length &&
    !(props.artifacts?.[m.id] ?? []).length
  )
}

interface Turn {
  kind: 'turn'
  key: string
  /** 按到达顺序渲染的分段（思考 / 正文 / 工具行）。 */
  msgs: any[]
  fileChanges: PiFileChange[]
  usage: PiUsage | null
  plan: { msg: any } | null
  attachments: any[]
  artifacts: Artifact[]
  /** 本轮末尾在等模型（waitCont 并入 turn：同一次回复不重复挂头像）。 */
  wait: boolean
  /**
   * 本轮仍在跑（内核未落定）。dsh 的行状态来自 block 是否 done，Pi 侧
   * 折算层不给 chip 打标记，就用「流式中 + 本轮是最后一行」判定 running。
   */
  live: boolean
  /**
   * 本轮以「用户中断」收场（dsh 中断后给 running root 合成落定的那一步）：
   * 收据位显「已中断」，告诉用户这段回复是被叫停的、可能不完整。
   */
  stopped: boolean
  /** 本轮正文（聚合好的纯文本，turn 尾部「复制」直接用，不再每渲染扫一遍 msgs）。 */
  text: string
}
interface UserRow {
  kind: 'user'
  key: string
  msg: any
  /** 该请求的运行链路（没有事件时为空，气泡下方就不出现链路行）。 */
  chain?: RunChainModel
}
interface SystemRow {
  kind: 'system'
  key: string
  msg: any
  /** notice 语义档（`sysNotice`）：决定图标与 tinted 底色。 */
  tone: SysTone
  icon: string
  /** 长文本：默认 2 行 clamp，给「展开」按钮。 */
  long: boolean
}
type Row = Turn | UserRow | SystemRow

/*
 * ── 系统文本 → notice 行（P0-2）────────────────────────────────────────
 * 内核/桥的系统消息是裸句子（「模型请求失败：…rate limit…」「自动重试中（第 3 次，8s 后）…」），
 * 原先渲染成中栏一段无归属的灰字，和一条普通提示长得一模一样。这里按语义分档：
 * 重试进度＝进行中（中性），失败/错误＝danger，未解析/无法/注意＝warn，其余＝中性。
 * `ponytail:` 判定依赖现有文案（src/composables/piEvents.ts 的三条前缀），匹配不上
 * 落中性档；升级路径是折算层直接给结构化 tone 字段而不是靠正则读句子。
 */
type SysTone = 'muted' | 'warn' | 'error'

/** 超过这个长度默认折两行，避免一条限流报错占满中栏。 */
const SYS_CLAMP_LEN = 160

function sysNotice(text: string): { tone: SysTone; icon: string } {
  if (/自动重试中|重试中/.test(text)) return { tone: 'muted', icon: 'refresh' } // i18n-ignore: backend message pattern
  if (/失败|错误|未响应|中断/.test(text)) return { tone: 'error', icon: 'alert-triangle' } // i18n-ignore: backend message pattern
  if (/未解析|无法|注意/.test(text)) return { tone: 'warn', icon: 'alert-triangle' } // i18n-ignore: backend message pattern
  return { tone: 'muted', icon: 'info' }
}

/** 已展开的长 notice 行 key。 */
const openSys = ref(new Set<string>())

function toggleSys(key: string) {
  const next = new Set(openSys.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  openSys.value = next
}

const stream = usePiEventsInjected()
const chains = computed(() => buildRunChains(stream?.events.value ?? []))

// 气泡只留一行入口；点它跳轨迹抽屉里的图（图本身不再挂在这里）。
const { focusRun } = useRunFocus()
function openChain(chain: RunChainModel) {
  focusRun(chain.runId)
}
function chainSummary(chain: RunChainModel): string {
  return runSummary(chain, Date.now()).parts.join(' → ')
}

/**
 * 用户气泡 ↔ 运行链路：按 prompt 前缀对；对不上再看时间邻近；
 * 两者都不成立就不挂——宁可不显示，也不把链路安到错的请求上。
 */
function chainForUser(
  text: string,
  ts: number | undefined,
  index: number,
): RunChainModel | undefined {
  const list = chains.value
  if (!list.length) return undefined
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
  const want = norm(String(text ?? '')).slice(0, 60)
  const hit = list.find((r) => {
    const p = norm(r.prompt).slice(0, 60)
    if (!p || !want) return false
    if (p === want) return true
    return want.length >= 8 && p.length >= 8 && (want.startsWith(p) || p.startsWith(want))
  })
  if (hit) return hit
  if (ts) {
    const near = list.filter((r) => Math.abs(r.startedAt - ts) < 120_000)
    if (near.length === 1) return near[0]
  }
  const byOrder = list[index]
  return byOrder && !byOrder.prompt ? byOrder : undefined
}

/**
 * turn 聚合渲染（对齐 dsh：一轮回复 = 一个块）。
 *
 * 数据层把一轮拆成 思考/正文/工具 chip/文件改动 多条消息（那是折算与
 * 流式性能的需要），这里按「连续 assistant」并回一个 turn：一个头像、
 * 一个 body，段内按到达顺序排 Think 折叠行 → 正文 → 工具行，
 * 文件改动 / 计划卡 / 附件 / 产物 / 用量统一收到 turn 尾部。
 * 用户与系统消息保持独立行。
 */
const rows = computed<Row[]>(() => {
  const out: Row[] = []
  let cur: Turn | null = null
  const seenChange = new Set<string>()
  let userIndex = 0

  for (const m of props.messages) {
    if (m.role === 'system') {
      const text = typeof m.text === 'string' ? m.text : ''
      const note = sysNotice(text)
      cur = null
      out.push({ kind: 'system', key: m.id, msg: m, tone: note.tone, icon: note.icon, long: text.length > SYS_CLAMP_LEN })
      continue
    }
    if (m.role !== 'assistant') {
      cur = null
      out.push({ kind: 'user', key: m.id, msg: m, chain: chainForUser(m.text, m.ts, userIndex) })
      userIndex += 1
      continue
    }
    if (isEmptyRow(m)) continue
    if (!cur) {
      cur = {
        kind: 'turn',
        key: m.id,
        msgs: [],
        fileChanges: [],
        usage: null,
        plan: null,
        attachments: [],
        artifacts: [],
        wait: false,
        live: false,
        stopped: false,
        text: '',
      }
      out.push(cur)
    }
    cur.msgs.push(m)
    // turn 正文只收「回复文本」：工具 chip 的参数/结果与计划卡都不属于回复内容。
    if (!m.tool && !m.plan && typeof m.text === 'string' && m.text) {
      cur.text = cur.text ? `${cur.text}\n\n${m.text}` : m.text
    }
    for (const c of m.fileChanges ?? []) {
      if (seenChange.has(c.id)) continue
      seenChange.add(c.id)
      cur.fileChanges.push(c)
    }
    if (m.usage) cur.usage = m.usage
    if (m.plan && !cur.plan) cur.plan = { msg: m }
    cur.attachments.push(...(m.attachments ?? []))
    cur.artifacts.push(...(props.artifacts?.[m.id] ?? []))
  }
  if (waiting.value && cur) cur.wait = true
  // dsh 的 TurnStatus 挂在 running 的最后一个 turn 尾部，工具执行期同样在；
  // live 就是这个「本轮未落定」标记（只有末尾 turn 可能是 live）。
  if (cur && props.streaming) cur.live = true
  // 中断回执：abort 成功时 streaming 已经落定为 false，所以判据只能是
  // 「末尾那一轮 + 用户点过中断」（写法照 live，中断只可能发生在末尾轮上）。
  if (cur && props.interrupted) cur.stopped = true
  return out
})

/** 没有 assistant turn 可并时，等待线才自己占一行（= 旧 waitCont 的反面）。 */
const waitStandalone = computed(
  () => waiting.value && !(rows.value.length && rows.value[rows.value.length - 1].kind === 'turn'),
)

/**
 * 折叠摘要取「最后一行」（dsh 的 latestLine）：思考是流式追加的，
 * 最后一行才是当前正在想的东西，首行早就看完了。
 */
function latestLine(text?: string): string {
  if (!text) return ''
  const s = text.replace(/\s+$/, '')
  const i = s.lastIndexOf('\n')
  return i >= 0 ? s.slice(i + 1).trim() : s
}

/**
 * Think 行的摘要选择（dsh `ReasoningRow`：`summary = running ? latestLine : firstLine`）。
 *
 * 流式中的末尾消息显最新一行——首行早滚过去了；落定后固定显首行，
 * 摘要才不会再随每帧重渲染跳动。
 */
function thinkSummary(row: Turn, m: any): string {
  return row.live && m === row.msgs[row.msgs.length - 1]
    ? latestLine(m.reasoning)
    : firstLine(m.reasoning ?? '')
}

/**
 * turn 操作行的时钟（dsh `MessageIconActions` 的 clock 位）：取本轮最后一条
 * 带 ts 的消息。journal 回放的消息可能整轮都没有 ts，返回空串让模板隐藏时钟——
 * 没有数据源就宁可不显，不编一个假时间。
 */
function turnClock(row: Turn): string {
  for (let i = row.msgs.length - 1; i >= 0; i--) {
    const ts = row.msgs[i].ts
    if (ts) return fmtClock(ts)
  }
  return ''
}

/**
 * 工具行摘要缓存：折叠行显示的是「标题 · 语义摘要」（对齐 dsh ToolRow），
 * 需要 JSON.parse 参数。模板里的函数在每次流式事件都会重跑，不缓存就是
 * 每条 message_update 对全部历史工具行重解析一遍。key = 工具名 + 参数 + 项目根。
 */
const toolSummaryCache = new Map<string, ToolRowSummary>()

function toolRow(m: any): ToolRowSummary {
  const args = typeof m.toolArgs === 'string' ? m.toolArgs : ''
  const key = `${m.tool}\u0000${args}\u0000${props.root}`
  let hit = toolSummaryCache.get(key)
  if (hit === undefined) {
    hit = summarizeToolCall(m.tool ?? '', args, props.root)
    if (toolSummaryCache.size > 400) toolSummaryCache.clear()
    toolSummaryCache.set(key, hit)
  }
  return hit
}

/**
 * 工具行的完整视图（dsh `toolRowModel` + `leadingFor` + `failureLine`）。
 *
 * 状态决定前导图标与行内扫光；失败时摘要换成错误首行——失败行显示
 * 「Read · src/a.ts」没有信息量，报错内容才是用户要点开看的东西。
 */
function toolRowView(m: any, live: boolean) {
  const state = toolRowState({
    toolResult: m.toolResult,
    toolError: m.toolError,
    streaming: live,
  })
  const base = toolRow(m)
  const failed = state === 'error'
  return {
    icon: base.icon,
    title: base.title,
    // ok 不写 data-state：只有 running/error 需要视觉信号
    state: state === 'ok' ? '' : state,
    tone: failed ? 'error' : '',
    summary: failed && m.toolResult ? firstLine(String(m.toolResult)) : base.summary,
  }
}

/** 已「展开剩余 N 行」的工具消息 id（dsh `terminal.expandRest`）。 */
const fullBody = ref(new Set<string>())

function toggleFullBody(id: string) {
  const next = new Set(fullBody.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  fullBody.value = next
}

/**
 * 展开体里的结果文本（dsh DiffBlock/ReadBlock 的 `maxLines: 8`）。
 *
 * 只在展开时被调用（折叠态整段 DOM 不存在），因此不必缓存：截断就是
 * split + slice，比让它撑 260px 的滚动区便宜。
 * 末尾的退出码先摘出来单独成行——正文截到 8 行时，「跑没跑成」这一行
 * 恰恰是最不能被截掉的。
 */
function resultView(m: any): { text: string; hidden: number; exit: string } {
  const raw = typeof m.toolResult === 'string' ? m.toolResult : ''
  const split = splitExitCode(raw)
  if (fullBody.value.has(m.id)) return { text: split.body, hidden: 0, exit: split.exit }
  const clipped = clipLines(split.body)
  return { text: clipped.text, hidden: clipped.hidden, exit: split.exit }
}

/**
 * 展开体的参数块（P0-3a）：bash 的命令、edit/write 的路径 + 内容，
 * 取不到已知字段才回落缩进 JSON。
 */
function argsBlocks(m: any) {
  return toolArgsBlocks(m.tool ?? '', typeof m.toolArgs === 'string' ? m.toolArgs : '', props.root)
}

/**
 * 文件 chip 的增删行数缓存（key = 改动 id）。
 *
 * chip 一行一个，一次 turn 可能十几个文件，而模板函数每条流式事件都重跑；
 * `changeDelta` 要摊平 diff 行，不缓存就是每事件重算全部历史文件的 diff。
 */
const deltaCache = new Map<string, { added: number; deleted: number }>()

function fileDelta(c: PiFileChange) {
  let hit = deltaCache.get(c.id)
  if (hit === undefined) {
    hit = changeDelta(c)
    if (deltaCache.size > 400) deltaCache.clear()
    deltaCache.set(c.id, hit)
  }
  return hit
}

/** 本轮末尾是否在跑（dsh 只有最新 turn 的操作行常驻显示）。 */
function isLastRow(row: Row): boolean {
  return rows.value[rows.value.length - 1] === row
}

/** turn 汇总行的合计增删：复用 chip 的缓存，同一份 diff 不摊第二次。 */
function turnTotals(cs: PiFileChange[]): { added: number; deleted: number } {
  return cs.reduce(
    (acc, c) => {
      const d = fileDelta(c)
      return { added: acc.added + d.added, deleted: acc.deleted + d.deleted }
    },
    { added: 0, deleted: 0 },
  )
}

/** 本轮步数：与轨迹面板统计区同一个口径（`messages.filter(m => m.tool).length`）。 */
function turnSteps(row: Turn): number {
  return row.msgs.filter((m) => m.tool).length
}

/**
 * 过程折叠（用户截图：一轮里 9 条工具行平铺，正文被挤到很远）。
 *
 * 规则：工具行 ≥ 3 时折成一行「过程 · N 步工具调用」；
 * 本轮未落定（live）默认展开，跑完默认收起；本轮有失败工具行则始终默认展开
 * （报错不能藏）。用户点过就记住，不再按流式状态反复抢开合。
 */
const PROC_MIN_STEPS = 3
const procOpen = ref(new Map<string, boolean>())

function procCollapsible(row: Turn): boolean {
  return turnSteps(row) >= PROC_MIN_STEPS
}

function procHasError(row: Turn): boolean {
  return row.msgs.some((m) => m.tool && m.toolError)
}

function isProcOpen(row: Turn): boolean {
  const fixed = procOpen.value.get(row.key)
  if (fixed !== undefined) return fixed
  return row.live || procHasError(row)
}

function toggleProc(row: Turn) {
  const next = new Map(procOpen.value)
  next.set(row.key, !isProcOpen(row))
  procOpen.value = next
}

/** 已点开的 chip 对应的改动（按到达顺序，同一 turn 允许多个同时展开）。 */
function openedChanges(row: Turn): PiFileChange[] {
  return row.fileChanges.filter((c) => openFiles.value.has(c.id))
}

/*
 * 本轮计时（dsh `TurnStatus`）：状态行常驻到本轮落定，计时满 15s 才显示。
 * 一上来就报「0:03」只会诱导用户盯秒表，短回复保持安静。
 */
const turnStart = ref(0)
const nowTick = ref(0)
let tickTimer: ReturnType<typeof setInterval> | null = null

watch(
  () => props.streaming,
  (on) => {
    if (on) {
      turnStart.value = Date.now()
      nowTick.value = turnStart.value
      tickTimer ??= setInterval(() => (nowTick.value = Date.now()), 1000)
    } else if (tickTimer) {
      clearInterval(tickTimer)
      tickTimer = null
    }
  },
)

onBeforeUnmount(() => {
  if (tickTimer) clearInterval(tickTimer)
})

/** ≥15s 才显示计时（dsh `showClock = elapsedMs >= 15e3`）。 */
const showClock = computed(() => props.streaming && nowTick.value - turnStart.value >= 15000)

const elapsedText = computed(() => {
  const s = Math.max(0, Math.floor((nowTick.value - turnStart.value) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
})

/**
 * markdown 渲染缓存：渲染函数跑在模板里，MessageList 任何响应式变化
 * （典型：流式期间每条 message_update）都会重渲整列 —— 不缓存的话每条
 * 事件都对全部历史消息重跑 marked.parse，主线程被打满，直接表现为
 * 输入框回显卡顿「打了半天字才蹦出来」。key = 消息 id + 全文，命中即零成本。
 */
const mdCache = new Map<string, string>()

function render(m: { id: string; text: string }) {
  const key = `${m.id}\u0000${m.text}`
  let html = mdCache.get(key)
  if (html === undefined) {
    html = marked.parse(m.text || '', { breaks: true }) as string
    if (mdCache.size > 400) mdCache.clear()
    mdCache.set(key, html)
  }
  return html
}

/** 复制用户消息：短暂回显「已复制」，失败静默（剪贴板被系统拒绝不是对话区的错）。 */
const copiedKey = ref<string | null>(null)
let copyTimer: ReturnType<typeof setTimeout> | null = null
async function copyMsg(key: string, text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    return
  }
  copiedKey.value = key
  if (copyTimer) clearTimeout(copyTimer)
  copyTimer = setTimeout(() => (copiedKey.value = null), 1500)
}
</script>

<template>
  <div class="msgs">
    <div v-if="!messages.length" class="empty">
      <span class="empty-icon"><AppIcon name="sparkles" :size="28" /></span>
      <strong>{{ t('向 Pi 下达编码任务') }}</strong>
      <span class="muted">{{ t('选好活动项目后，在下方输入框开始对话。') }}</span>
    </div>

    <template v-for="row in rows" :key="row.key">
      <!-- ── 系统行（notice）：状态图标 + tinted 容器，长文本默认两行（P0-2） ── -->
      <div v-if="row.kind === 'system'" class="msg-row system" :class="`sys-${row.tone}`">
        <div class="sys-body">
          <span class="sys-ic" aria-hidden="true"><AppIcon :name="row.icon" :size="14" /></span>
          <div class="sys-note">
            <!-- pre-wrap：内核文案自带换行，插值必须贴着标签写，否则模板换行会变成正文空行 -->
            <span class="sys-text" :class="{ 'sys-clamp': row.long && !openSys.has(row.key) }">{{ row.msg.text }}</span>
            <AppButton v-if="row.long" variant="text" class="sys-expand" @click="toggleSys(row.key)">
              {{ openSys.has(row.key) ? t('收起') : t('展开') }}
            </AppButton>
          </div>
        </div>
      </div>

      <!-- ── 用户行：右对齐气泡 + 气泡外的复制 / 回到此处（F7：每条头像删除） ── -->
      <div v-else-if="row.kind === 'user'" class="msg-row user">
        <div class="msg-body">
          <div class="txt">{{ row.msg.text }}</div>
          <div class="user-actions">
            <AppButton
              variant="text"
              class="ghost-btn"
              :title="copiedKey === row.key ? t('已复制') : t('复制这条消息')"
              @click="copyMsg(row.key, row.msg.text)"
            >
              <AppIcon :name="copiedKey === row.key ? 'check' : 'copy'" :size="12" />
              <span>{{ copiedKey === row.key ? t('已复制') : t('复制') }}</span>
            </AppButton>
            <!-- G3「回到此处」：仅带 checkpoint turn 的 user 消息可回滚。 -->
            <AppButton
              v-if="row.msg.turnSeq"
              variant="text"
              class="ghost-btn rewind-btn"
              :title="t('回到此处：还原该轮改过的文件，并重开会话到这条消息处')"
              @click="emit('rewind', row.msg)"
            >
              <AppIcon name="history" :size="12" />
              <span>{{ t('回到此处') }}</span>
            </AppButton>
            <!-- dsh 的密度策略是「按钮常驻、时间 hover 才显」：这行本来就整行
                 hover 浮现，时钟挂在末尾即可，不再单独做一套显隐规则。 -->
            <span v-if="row.msg.ts" class="u-clock">{{ fmtClock(row.msg.ts) }}</span>
          </div>
          <MessageAttachments v-if="row.msg.attachments?.length" :attachments="row.msg.attachments" />
          <div v-if="(artifacts?.[row.msg.id] ?? []).length" class="acstrip">
            <ArtifactCard
              v-for="a in artifacts[row.msg.id]"
              :key="a.path"
              :artifact="a"
              :active="open?.path === a.path"
              @open="open = $event"
            />
          </div>
          <!-- 每个请求一行入口：图在轨迹抽屉里，气泡下不再铺摘要。 -->
          <button v-if="row.chain" class="run-entry" type="button" @click="openChain(row.chain)">
            <AppIcon name="activity" :size="12" />
            <span class="re-text">{{ t('运行链路') }}</span>
            <span class="re-sum">{{ chainSummary(row.chain) }}</span>
            <AppIcon name="chevron-right" :size="11" />
          </button>
        </div>
      </div>

      <!-- ── assistant turn：一个头像、一段回复（F5：等待态不再给整行挂 waiting 类） ── -->
      <div v-else class="msg-row assistant">
        <div
          class="msg-body"
          :class="{
            'no-rail': !row.live && turnSteps(row) === 0,
            'proc-collapsed': procCollapsible(row) && !isProcOpen(row),
          }"
        >
          <!-- 头像并进 turn 栅格第一格：rail 竖线（left:12.5px）与头像圆心同一次坐标，
               头像留在 .msg-row 的 flex 里时两者的参照系不同，线会整体右偏 38px。 -->
          <div class="msg-avatar">
            <span class="pi-mark">π</span>
          </div>
          <div class="msg-meta">
            <strong>Pi</strong>
          </div>

          <!-- 过程折叠头：结构沿用工具行的 .crow + .crow-head，不另造形态。 -->
          <div v-if="procCollapsible(row)" class="crow proc-head" :class="{ open: isProcOpen(row) }">
            <AppButton
              variant="menu-item"
              class="crow-head"
              :aria-expanded="isProcOpen(row)"
              @click="toggleProc(row)"
            >
              <span class="crow-ic">
                <AppIcon name="chevron-right" :size="11" class="crow-caret" />
                <AppIcon name="activity" :size="12" class="crow-icon" />
              </span>
              <span class="crow-main">
                <span class="crow-title">{{ t('过程') }}</span>
                <span class="crow-sep" aria-hidden="true" />
                <span class="crow-summary">{{ t('{0} 步工具调用', [turnSteps(row)]) }}</span>
              </span>
            </AppButton>
          </div>

          <template v-for="m in row.msgs" :key="m.id">
            <!-- Think 折叠行：整轮思考压成一行，展开看全文（对齐 dsh） -->
            <CollapsibleRow
              v-if="m.reasoning"
              icon="cpu"
              title="Think"
              :summary="thinkSummary(row, m)"
            >
              <pre class="crow-pre">{{ m.reasoning }}</pre>
            </CollapsibleRow>

            <!-- 工具行：图标 + 标题 · 语义摘要 + 运行状态（dsh ToolRow 同款），展开看参数 / 结果 -->
            <CollapsibleRow
              v-if="m.tool"
              v-bind="toolRowView(m, row.live)"
              :empty-text="m.toolResult ? '' : t('无参数')"
            >
              <!-- 参数按语义分块：命令 / 路径 / 内容各占一行，只有未知形状才回落 JSON -->
              <template v-for="b in argsBlocks(m)" :key="b.label">
                <p class="crow-label">{{ b.label }}</p>
                <pre class="crow-pre" :class="{ 'crow-code': b.code }">{{ b.text }}</pre>
              </template>
              <template v-if="m.toolResult">
                <p class="crow-label">{{ m.toolError ? t('错误') : t('结果') }}</p>
                <div class="crow-out" :class="{ 'crow-err': m.toolError }">
                  <pre class="crow-pre">{{ resultView(m).text }}</pre>
                  <!-- 退出码单独一行：整段输出里唯一能回答「跑没跑成」的一行 -->
                  <p v-if="resultView(m).exit" class="crow-exit">{{ resultView(m).exit }}</p>
                  <!-- dsh `expandRest`：默认只给 8 行，剩下的按行数主动展开 -->
                  <AppButton
                    v-if="resultView(m).hidden"
                    variant="text"
                    class="crow-btn"
                    @click="toggleFullBody(m.id)"
                  >{{ t('展开剩余 {0} 行', [resultView(m).hidden]) }}</AppButton>
                  <!-- dsh TerminalBlock 的 copy/copied：贴块右上角，hover / 聚焦才浮现 -->
                  <AppButton
                    variant="text"
                    class="crow-btn crow-copy"
                    @click="copyMsg(`r:${m.id}`, m.toolResult)"
                  >
                    {{ copiedKey === `r:${m.id}` ? t('已复制') : t('复制') }}
                  </AppButton>
                </div>
              </template>
            </CollapsibleRow>

            <!--
              流式输出期间不做 markdown 解析：每条 message_update 都带**累计全文**，
              逐字重渲 + marked.parse 会让主线程在长回复里 O(n²) 饱和，表现为整窗卡死、
              输入法 run loop 同步失败（IMKCFRunLoopWakeUpReliable）。落定（streaming=false）
              后再解析一次即可，渲染成本从「每条事件」降到「每条消息一次」。
            -->
            <div
              v-else-if="m.streaming && m.text"
              class="md streaming"
            >
              {{ m.text }}
              <span class="cursor">▍</span>
            </div>
            <!-- G5：计划卡的 assistant 消息不再重复渲染原文（步骤以卡片为准，正文那版编号列表会双重显示）。 -->
            <div v-else-if="m.text && !m.plan" class="md" v-html="render(m)"></div>
          </template>

          <!--
            G2 本轮文件改动（对齐 dsh 的一行汇总 + 文件入口）：turn 尾部一行
            「本轮文件改动 · N +x −y」，下面是文件 chip 横排，点 chip 展开该文件 diff。
            dsh 侧的 chip 形态没有编译产物实证（它走 turnTail slot 注入），
            有实证的是「文件入口 = 一条可点的弱色名字 + 宿主预览」；Pi 的预览面板
            在 TraceDrawer 里（非常驻），接过去要多开一条抽屉链路，因此保留行内 diff。
          -->
          <div v-if="row.fileChanges.length" class="msg-files">
            <div class="files-head">
              <AppIcon name="file-diff" :size="13" />
              <span>{{ t('本轮文件改动 · {0}', [row.fileChanges.length]) }}</span>
              <span class="files-sum">
                +{{ turnTotals(row.fileChanges).added }} −{{ turnTotals(row.fileChanges).deleted }}
              </span>
              <span class="files-note">{{ t('bash 变更不跟踪') }}</span>
            </div>
            <div class="file-chips">
              <AppButton
                v-for="c in row.fileChanges"
                :key="c.id"
                variant="secondary"
                class="file-chip"
                :class="{ on: openFiles.has(c.id) }"
                :title="c.path"
                @click="toggleFile(c.id)"
              >
                <AppIcon :name="c.tool === 'write' ? 'file' : 'edit'" :size="12" />
                <span class="chip-name">{{ fileName(c.path) }}</span>
                <span class="chip-delta">
                  +{{ fileDelta(c).added }} −{{ fileDelta(c).deleted }}
                </span>
              </AppButton>
            </div>
            <div v-for="c in openedChanges(row)" :key="`diff-${c.id}`" class="file-diff-block">
              <p class="file-diff-path">{{ relativizeToCwd(c.path, root) }}</p>
              <!-- F18：unified 单栏也能读出「哪边是删、哪边是增」——图例头带计数，不强行双栏。 -->
              <p class="file-diff-legend">
                <span class="fdl del">{{ t('− 删除 {0}', [fileDelta(c).deleted]) }}</span>
                <span class="fdl add">{{ t('+ 新增 {0}', [fileDelta(c).added]) }}</span>
              </p>
              <pre class="file-diff"><span
                v-for="(ln, i) in diffLines(c)"
                :key="i"
                class="dl"
                :class="ln.kind"
              >{{ ln.kind === 'add' ? '+' : '-' }}{{ ln.text }}</span></pre>
            </div>
          </div>

          <!-- G5 计划卡（对齐 Cursor Plan mode / Claude Code 计划批准流） -->
          <div v-if="row.plan" class="plan-card" :class="row.plan.msg.plan.state">
            <div class="plan-head">
              <AppIcon name="list" :size="13" />
              <span>{{ t('执行计划') }}</span>
              <span class="plan-count">{{ t('{0} 步', [row.plan.msg.plan.steps.length]) }}</span>
            </div>
            <ol class="plan-steps">
              <li v-for="(s, i) in row.plan.msg.plan.steps" :key="i">
                <AppIcon name="check" :size="12" />
                <span class="plan-step-text">{{ s }}</span>
              </li>
            </ol>
            <div v-if="row.plan.msg.plan.state === 'pending'" class="plan-actions">
              <AppButton
                variant="primary"
                class="plan-btn primary"
                :title="t('按此计划执行（将作为新任务下发）')"
                @click="emit('plan-execute', row.plan.msg)"
              >
                <AppIcon name="play" :size="12" />
                <span>{{ t('开始执行') }}</span>
              </AppButton>
              <AppButton variant="secondary" class="plan-btn" :title="t('把计划步骤放回输入框修改')" @click="emit('plan-revise', row.plan.msg)">
                <AppIcon name="edit" :size="12" />
                <span>{{ t('修改计划') }}</span>
              </AppButton>
            </div>
            <div v-else class="plan-running">
              <AppIcon name="zap" :size="12" :class="{ spin: streaming }" />
              <span>{{ t('执行中…') }}</span>
            </div>
          </div>

          <MessageAttachments v-if="row.attachments.length" :attachments="row.attachments" />

          <div v-if="row.artifacts.length" class="acstrip">
            <ArtifactCard
              v-for="a in row.artifacts"
              :key="a.path"
              :artifact="a"
              :active="open?.path === a.path"
              @open="open = $event"
            />
          </div>

          <!-- 本轮收据（ai-console.md §6）：跑完一轮钉一行 quiet mono receipt。
               token 已归轨迹面板的统计区（批 3 F10），同屏不重复同一个数字——收据只留步数 + 成本，
               完整 token 口径 hover 可查。本轮时长仍不显（ts 只到消息粒度，被中断那轮的
               首末差更不是「耗时」），没有可信口径就不编。 -->
          <div
            v-if="row.usage && !row.msgs.some((m) => m.streaming) && (turnSteps(row) > 0 || row.usage.cost.total > 0)"
            class="msg-usage"
            :title="t('输入 {0} · 输出 {1} · 缓存读 {2} · 缓存写 {3} · 合计 {4} tokens', [row.usage.input, row.usage.output, row.usage.cacheRead, row.usage.cacheWrite, row.usage.totalTokens])"
          >
            {{ t('{0} 步 · {1}', [turnSteps(row), fmtCost(row.usage.cost.total)]) }}
          </div>
          <!-- 中断回执（dsh：abort 给 running root 合成落定）：用量没上报时
               至少留一行「已中断」，否则被叫停的那轮看起来像凭空消失。 -->
          <div
            v-else-if="row.stopped"
            class="msg-usage msg-stopped"
            :title="t('本轮由用户中止，最后一段输出可能不完整')"
          >{{ t('已中断') }}</div>

          <!--
            dsh `MessageIconActions({text,time,clock,onBranch,usageAction})` 实证是
            「复制 / 分支 / 用量 / 时钟」四件套，图标只有 copy 与 check 两种回显；
            `thumbsUp`/`thumbs` 在三个编译包里 0 命中，`retry` 全部属于错误重试行
            （`.retryRow` / `.retrySummary`）、`feedback` 唯一命中是 TurnErrorItem 的注释，
            都不是消息操作位——所以这里只做复制 + 时钟，不造赞/踩（无后端存储）。
            时钟的数据源是消息上的 `ts`（回放消息没有就整颗隐藏）。
            「分支」Pi 已有等价入口（用户气泡上的「回到此处」按 checkpoint 重开该轮）。
            图标行按 dsh `data-actions-reveal`：本轮常驻，历史轮 hover 才显现。
          -->
          <div
            v-if="!row.live"
            class="turn-actions"
            :data-actions-reveal="isLastRow(row) ? 'always' : 'hover'"
          >
            <AppButton
              variant="icon"
              class="ta-btn"
              :disabled="!row.text"
              :title="copiedKey === row.key ? t('已复制') : t('复制本轮回复')"
              :aria-label="copiedKey === row.key ? t('已复制') : t('复制本轮回复')"
              @click="copyMsg(row.key, row.text)"
            >
              <AppIcon :name="copiedKey === row.key ? 'check' : 'copy'" :size="15" />
            </AppButton>
            <span v-if="turnClock(row)" class="ta-clock">{{ turnClock(row) }}</span>
          </div>

          <!--
            本轮状态行（dsh TurnStatus）= rail 尾部的 live 步：
            26px 位一颗心跳环落在竖线上，右侧一行状态文字，满 15s 才显示计时。
          -->
          <div v-if="row.live" class="turn-status" role="status" aria-live="polite">
            <span class="ts-ic" aria-hidden="true" />
            <span class="ts-text">{{ row.wait ? t('等待模型响应…') : t('正在处理本轮…') }}</span>
            <span v-if="showClock" class="ts-clock">{{ elapsedText }}</span>
          </div>
        </div>
      </div>
    </template>

    <!--
      前面没有 assistant turn 可并时，等待态才自己占一行。
      F5：这行不再有头像和「Pi」meta——悬空形态就是用户截图里的孤立蓝圈，
      只留 rail 上的那颗心跳环 + 一行字。
    -->
    <div v-if="waitStandalone" class="msg-row assistant">
      <div class="msg-body no-rail">
        <div class="turn-status" role="status" aria-live="polite">
          <span class="ts-ic" aria-hidden="true" />
          <span class="ts-text">{{ t('等待模型响应…') }}</span>
          <span v-if="showClock" class="ts-clock">{{ elapsedText }}</span>
        </div>
      </div>
    </div>

    <ArtifactPreview
      v-if="open"
      :artifact="open"
      :root="root"
      @close="open = null"
    />
  </div>
</template>

<style src="./MessageList.css" scoped></style>
