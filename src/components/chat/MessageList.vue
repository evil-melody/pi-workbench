<script setup lang="ts">
import { computed, ref } from 'vue'
import { marked } from 'marked'
import AppIcon from '@/components/ui/AppIcon.vue'
import ArtifactCard from './ArtifactCard.vue'
import ArtifactPreview from './ArtifactPreview.vue'
import type { Artifact } from '@/composables/useArtifacts'
import { fmtCost, fmtTokens } from '@/composables/piEvents'
import { diffLines, summarizeChange, type PiFileChange } from '@/utils/fileChanges'

const props = defineProps<{
  messages: any[]
  streaming: boolean
  artifacts: Record<string, Artifact[]>
  root: string
}>()

const emit = defineEmits<{
  rewind: [msg: { id: string; turnSeq?: number; text: string }]
  'plan-execute': [msg: any]
  'plan-revise': [msg: any]
}>()

const open = ref<Artifact | null>(null)
/** G2：已展开 diff 的文件改动 id（同一条消息里多个文件可同时展开）。 */
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
 * 空块判定：assistant 消息没有任何可展示内容（无文本/工具名/文件改动/
 * 计划/附件/用量/产物）就不渲染整行——journal 回放和流式折算都可能产生
 * 这种空壳，逐块渲染就是用户截图里「一个个空 Pi 头像」的来源。
 */
function isEmptyRow(m: any): boolean {
  if (m.role !== 'assistant') return false
  // 正文只 trim 后判空：流式折算 / 回放常产出纯空白的 assistant 壳消息，
  // 不 trim 就会漏过、渲染成一个个空蓝圈（用户截图里「一排头像」的来源）。
  const text = typeof m.text === 'string' ? m.text.trim() : ''
  return (
    !text &&
    !m.tool &&
    !m.plan &&
    !m.usage &&
    !m.fileChanges?.length &&
    !m.attachments?.length &&
    !(props.artifacts?.[m.id] ?? []).length
  )
}

/**
 * 连续 assistant 消息合并展示（对齐主流 AI 界面：同一次回复不重复挂头像）。
 * 流式折算会把一次回复拆成 文本块/工具 chip/文件改动 多条消息——那是数据层
 * 的分组需要；渲染层把它们画成一个连续块，只有首行带头像与名字。
 */
/** 可见行下标集合：模板里跳过空块，连续性判定也要跳过它们再往前看。 */
const visibleRows = computed(() => {
  const flags: { empty: boolean; cont: boolean }[] = []
  let prevAssistant = false
  for (let i = 0; i < props.messages.length; i++) {
    const m = props.messages[i]
    const empty = isEmptyRow(m)
    const cont = !empty && prevAssistant && m.role === 'assistant'
    flags.push({ empty, cont })
    if (!empty) prevAssistant = m.role === 'assistant'
  }
  return flags
})

/**
 * 等待行是否并入前一段 assistant 输出：工具 chip 跑完等模型续答时，
 * 「等待模型响应…」属于同一次回复，不该自己再挂一个头像 + 名字
 * （用户截图里第三个小蓝圈的来源）。最后一条可见消息是 assistant 即并入。
 */
const waitCont = computed(() => {
  for (let i = props.messages.length - 1; i >= 0; i--) {
    if (visibleRows.value[i]?.empty) continue
    return props.messages[i].role === 'assistant'
  }
  return false
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
</script>

<template>
  <div class="msgs">
    <div v-if="!messages.length" class="empty">
      <span class="empty-icon"><AppIcon name="sparkles" :size="28" /></span>
      <strong>向 Pi 下达编码任务</strong>
      <span class="muted">选好活动项目后，在下方输入框开始对话。</span>
    </div>

    <!--
      系统行（内联提示）：连续 system 消息共用一个 π 头像——一次对话里的
      报错/重试是一件事，不该每个错误都挂一个图标。首行带头像，后续行占位对齐。
      assistant 连续行（cont）同理：一次回复拆成的文本/工具/文件块只挂一次头像，
      空壳块（回放与流式折算的副产物）整行不渲染。
    -->
    <template v-for="(m, i) in messages" :key="m.id">
      <div
        v-if="!visibleRows[i]?.empty"
        class="msg-row"
        :class="[
          m.role,
          {
            'sys-first': m.role === 'system' && !(messages[i - 1]?.role === 'system'),
            cont: visibleRows[i]?.cont,
          },
        ]"
      >
      <div v-if="m.role === 'system'" class="sys-line">
        <span class="sys-pi" aria-hidden="true">π</span>
        <strong>pi</strong>
        <span class="sys-text">{{ m.text }}</span>
      </div>
      <template v-else>
      <div class="msg-avatar">
        <template v-if="!visibleRows[i]?.cont">
          <AppIcon v-if="m.role === 'user'" name="user" :size="16" />
          <span v-else class="pi-mark">π</span>
        </template>
      </div>
      <div class="msg-body">
        <div v-if="!visibleRows[i]?.cont" class="msg-meta" :class="{ 'has-rewind': m.role === 'user' && m.turnSeq }">
          <strong>{{ m.role === 'user' ? '你' : 'Pi' }}</strong>
          <!-- G3「回到此处」：仅带 checkpoint turn 的 user 消息可回滚。 -->
          <button
            v-if="m.role === 'user' && m.turnSeq"
            class="rewind-btn"
            title="回到此处：还原该轮改过的文件，并重开会话到这条消息处"
            @click="emit('rewind', m)"
          >
            <AppIcon name="history" :size="12" />
            <span>回到此处</span>
          </button>
        </div>
        <div v-if="m.tool" class="msg-tool">
          <AppIcon name="zap" :size="13" />
          {{ m.tool }}
        </div>
        <!--
          流式输出期间不做 markdown 解析：每条 message_update 都带**累计全文**，
          逐字重渲 + marked.parse 会让主线程在长回复里 O(n²) 饱和，表现为整窗卡死、
          输入法 run loop 同步失败（IMKCFRunLoopWakeUpReliable）。落定（streaming=false）
          后再解析一次即可，渲染成本从「每条事件」降到「每条消息一次」。
        -->
        <div v-else-if="m.role === 'assistant' && m.streaming" class="md streaming">{{ m.text }}</div>
        <!-- G5：计划卡的 assistant 消息不再重复渲染原文（步骤以卡片为准，正文那版编号列表会双重显示）。 -->
        <div
          v-else-if="m.role === 'assistant' && (m.text || !m.fileChanges?.length) && !m.plan"
          class="md"
          v-html="render(m)"
        ></div>
        <div v-else-if="m.role !== 'assistant'" class="txt">{{ m.text }}</div>

        <!--
          G5 计划卡（对齐 Cursor Plan mode / Claude Code 计划批准流）：
          plan 轮回复落定后解析出的分步计划， checklist + 「开始执行 / 修改计划」。
          点执行才发执行 prompt——先审方案再动手。
        -->
        <div v-if="m.plan" class="plan-card" :class="m.plan.state">
          <div class="plan-head">
            <AppIcon name="list" :size="13" />
            <span>执行计划</span>
            <span class="plan-count">{{ m.plan.steps.length }} 步</span>
          </div>
          <ol class="plan-steps">
            <li v-for="(s, i) in m.plan.steps" :key="i">
              <AppIcon name="check" :size="12" />
              <span class="plan-step-text">{{ s }}</span>
            </li>
          </ol>
          <div v-if="m.plan.state === 'pending'" class="plan-actions">
            <button
              class="plan-btn primary"
              title="按此计划执行（将作为新任务下发）"
              @click="emit('plan-execute', m)"
            >
              <AppIcon name="play" :size="12" />
              <span>开始执行</span>
            </button>
            <button
              class="plan-btn"
              title="把计划步骤放回输入框修改"
              @click="emit('plan-revise', m)"
            >
              <AppIcon name="edit" :size="12" />
              <span>修改计划</span>
            </button>
          </div>
          <div v-else class="plan-running">
            <AppIcon name="zap" :size="12" :class="{ spin: streaming }" />
            <span>执行中…</span>
          </div>
        </div>

        <!--
          G2 文件改动块（Cursor 式 changed-files）：本轮 edit/write 的目标文件
          逐个列出，点击展开 diff。没有它，agent 改了哪些文件只能靠 artifacts
          正则嗅探文本兜底——模型不提路径就漏。
        -->
        <div v-if="m.fileChanges?.length" class="msg-files">
          <div class="files-head">
            <AppIcon name="file-diff" :size="13" />
            <span>改动 {{ m.fileChanges.length }} 个文件</span>
            <span class="files-note">bash 产生的变更不跟踪</span>
          </div>
          <div v-for="c in m.fileChanges" :key="c.id" class="file-row">
            <button class="file-row-btn" @click="toggleFile(c.id)">
              <AppIcon
                name="chevron-right"
                :size="12"
                :class="['file-caret', { open: openFiles.has(c.id) }]"
              />
              <AppIcon :name="c.tool === 'write' ? 'file' : 'edit'" :size="13" />
              <span class="file-path" :title="c.path">{{ c.path }}</span>
              <span class="file-sum">{{ summarizeChange(c) }}</span>
            </button>
            <pre v-if="openFiles.has(c.id)" class="file-diff"><span
              v-for="(ln, i) in diffLines(c)"
              :key="i"
              class="dl"
              :class="ln.kind"
            >{{ ln.kind === 'add' ? '+' : '-' }}{{ ln.text }}</span></pre>
          </div>
        </div>

        <div v-if="m.attachments?.length" class="msg-attach">
          <span
            v-for="a in m.attachments"
            :key="a.id"
            class="att-ref"
            :class="a.kind"
            :title="a.path"
          >
            <AppIcon :name="a.kind === 'image' ? 'image' : 'file'" :size="13" />
            <span class="att-ref-name">{{ a.name }}</span>
          </span>
        </div>

        <div v-if="(artifacts?.[m.id] ?? []).length" class="acstrip">
          <ArtifactCard
            v-for="a in artifacts[m.id]"
            :key="a.path"
            :artifact="a"
            :active="open?.path === a.path"
            @open="open = $event"
          />
        </div>

        <span v-if="m.streaming" class="cursor">▍</span>

        <div
          v-if="m.role === 'assistant' && m.usage && !m.streaming"
          class="msg-usage"
          :title="`输入 ${m.usage.input} · 输出 ${m.usage.output} · 缓存读 ${m.usage.cacheRead} · 缓存写 ${m.usage.cacheWrite} · 合计 ${m.usage.totalTokens} tokens`"
        >
          <AppIcon name="zap" :size="11" />
          <span>↑{{ fmtTokens(m.usage.input) }}</span>
          <span>↓{{ fmtTokens(m.usage.output) }}</span>
          <span>Σ{{ fmtTokens(m.usage.totalTokens) }}</span>
          <span>{{ fmtCost(m.usage.cost.total) }}</span>
        </div>
      </div>
      </template>
    </div>
    </template>

    <!-- 等待模型响应：机器人侧占位气泡，回答首字到达前一直可见。
         前面已是 assistant 输出（cont）时并入同段：不重复挂头像与名字。 -->
    <div v-if="waiting" class="msg-row assistant waiting" :class="{ cont: waitCont }">
      <div class="msg-avatar">
        <span class="pi-mark">π</span>
      </div>
      <div class="msg-body">
        <div class="msg-meta">
          <strong>Pi</strong>
        </div>
        <div class="wait-line" role="status">
          <span class="dots" aria-hidden="true"><i /><i /><i /></span>
          <span class="wait-text">等待模型响应…</span>
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
