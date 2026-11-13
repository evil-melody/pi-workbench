<template>
  <div class="chat" :class="{ hero: showHero, 'aside-open': traceOpen && !showHero }">
    <section class="center" :class="{ hero: showHero }">
      <p v-if="notice" class="notice" role="status">
        <AppIcon name="info" :size="13" />
        <span>{{ notice }}</span>
      </p>

      <!--
        落地页：选了工作目录**也留在这里**，直到真的发出第一条消息。
        选完项目就把人扔进空会话里去，是这一页之前最刺眼的问题。
      -->
      <ChatHero
        v-if="showHero"
        :projects="projects"
        :cwd="cwd"
        :busy="heroPicking"
        @send="submitHero"
        @pick-project="setActiveProject"
        @pick-directory="onPickDirectory"
        @bind-directory="onBindDirectory"
        @pick-mode="setMode"
      />

      <template v-else>
        <header class="chat-header">
          <div class="header-pill">
            <!-- 项目名与工作目录是同一件事：一个控件收口，头部不再排两段文本。
                 角色 / 模式 / 模型与落地页一致下沉到输入框工具条，顶栏只留项目与动作。 -->
            <WorkspacePicker
              :projects="projects"
              :cwd="cwd"
              @pick-project="setActiveProject"
              @pick-directory="onPickDirectory"
              @bind-directory="onBindDirectory"
            />
          </div>

          <div class="chat-controls">
        <!-- 过程（会话树 / 轨迹 / 工作流 / 连接器）默认收起：主内容永远是对话本身 -->
          <AppButton
            variant="secondary"
            class="trace-toggle"
            :class="{ on: traceOpen }"
            :title="traceOpen ? t('收起过程面板') : t('展开过程面板：会话树 / 轨迹 / 智能体 / 工作流 / 连接器')"
            @click="traceOpen = !traceOpen"
          >
            <AppIcon name="activity" :size="14" />
            <span>{{ t('轨迹') }}</span>
            <i v-if="trackCalls" class="trace-badge">{{ trackCalls }}</i>
          </AppButton>

          <!-- G5 计划模式（对齐 Cursor Plan mode）：开启后发送的任务先出分步计划卡，
               点「开始执行」才真正动工具。 -->
          <AppButton
            variant="secondary"
            class="plan-toggle"
            :class="{ on: planMode }"
            :title="planMode ? t('计划模式已开启：先出计划，确认后执行') : t('开启计划模式：先审方案再动手')"
            @click="planMode = !planMode"
          >
            <AppIcon name="list" :size="13" />
            <span>{{ t('计划') }}</span>
          </AppButton>

          <!-- 会话迁移：导出当前对话为 JSON / 导入历史会话。 -->
          <div class="io-group" role="group" :aria-label="t('会话迁移')">
            <!--
              B3 压缩：内核原生 session.compact（长会话摘要回灌），压缩后上下文窗口
              重新拿回空间；fork（分支）在会话树里，这里只放最常用的压缩。
            -->
            <AppButton variant="text" class="io-btn"
              :disabled="compacting || streaming"
              :title="t('压缩当前会话：把历史轮次摘要化，释放上下文窗口空间')"
              @click="onCompact"
            >
              <AppIcon name="layers" :size="13" :class="{ spin: compacting }" />
              <span>{{ compacting ? t('压缩中…') : t('压缩') }}</span>
            </AppButton>
            <AppButton variant="text" class="io-btn" :title="t('导出当前会话为 JSON 文件')" @click="onExport">
              <AppIcon name="download" :size="13" />
              <span>{{ t('导出') }}</span>
            </AppButton>
            <AppButton variant="text" class="io-btn" :title="t('从 JSON 文件导入会话')" @click="onImport">
              <AppIcon name="upload" :size="13" />
              <span>{{ t('导入') }}</span>
            </AppButton>
          </div>
        </div>
        </header>

        <p v-if="ioNote" class="io-note" role="status">{{ ioNote }}</p>

        <p v-if="!IN_TAURI" class="nokernel">{{ t('浏览器模式：Pi 内核未接入，对话不可用。请运行') }}<code>npm run app:dev</code>{{ t('启动桌面 App。') }}</p>

        <MessageList
          :messages="messages"
          :streaming="streaming"
          :interrupted="abortedTurn"
          :artifacts="artifacts"
          :root="cwd"
          @rewind="onRewindRequest"
          @plan-execute="onPlanExecute"
          @plan-revise="onPlanRevise"
        />

        <!--
          本轮 agent 轨迹：抽屉可以收起，但步骤本身要看得见 ——
          发出任务后如果只剩一个转圈，用户无从判断 agent 到底动没动。
          F6：同名工具合并计数成一行「bash ×3 read ×1 · 共 9 步 42.6s」。
        -->
        <div v-if="stepsVisible" class="step-strip" role="status">
          <span class="step-groups">
            <span v-for="g in stepGroups" :key="g.title" class="step-chip" :title="g.detail">
              <span class="step-name">{{ g.title }}</span>
              <span v-if="g.count > 1" class="step-count">×{{ g.count }}</span>
            </span>
            <span v-if="!stepGroups.length" class="step-muted">{{ t('等待内核上报步骤…') }}</span>
          </span>
          <span class="step-times">
            <span class="step-sum">{{ t('共 {0} 步', [stepTotal]) }}</span>
            <span v-if="runSpanText" class="step-dur">{{ runSpanText }}</span>
          </span>
        </div>

        <!--
          B1 硬审批横幅：内核扩展拦截风险工具调用时在此等待用户批准。
          不回应则扩展侧超时 fail-closed（安全优先）。
        -->
        <ApprovalDialog />

        <!-- G3 回滚确认：还原文件 + 重开会话，均无法在 App 内撤销，须显式确认。 -->
        <AppModal :open="!!rewindTarget" :title="t('回到此处？')" size="sm">
          <p class="rewind-warn">{{ t('将把第 {0} 轮起改动的文件还原到该轮之前，并重开会话到这条消息处。 之后的对话内容会被移除，', [rewindTarget?.turnSeq]) }}<strong>{{ t('此操作无法撤销') }}</strong>。
          </p>
          <p class="rewind-note">{{ t('注意：bash 命令产生的文件变更不在还原范围（对齐 Claude Code checkpoint 的限制）。') }}</p>
          <template #footer>
            <AppButton variant="secondary" class="btn" :disabled="rewinding" @click="rewindTarget = null">{{ t('取消') }}</AppButton>
            <AppButton variant="danger" class="btn danger" :disabled="rewinding" @click="onRewindConfirm">
              {{ rewinding ? t('还原中…') : t('确认回滚') }}
            </AppButton>
          </template>
        </AppModal>

        <form class="composer" @submit.prevent="submit">
          <!--
            G6 队列 strip：流式中的提交进内核 follow_up 队列（本轮完全结束后
            自动执行）；插话（steer）在工具跑完、下次 LLM 调用前注入。
            队列内容以内核 queue_update 回推为权威，前端不维护副账。
          -->
          <div v-if="queueTotal > 0" class="queue-strip">
            <div v-if="queue.steering.length" class="queue-seg steer">
              <span class="queue-tag">{{ t('插话') }}</span>
              <span class="queue-hint">{{ t('下一轮模型调用前注入') }}</span>
              <span v-for="(t, i) in queue.steering" :key="'s' + i" class="queue-item" :title="t">{{ t }}</span>
            </div>
            <div v-if="queue.followUp.length" class="queue-seg followup">
              <span class="queue-tag">{{ t('排队') }}</span>
              <span class="queue-hint">{{ t('本轮结束后执行') }}</span>
              <span v-for="(t, i) in queue.followUp" :key="'f' + i" class="queue-item" :title="t">{{ t }}</span>
            </div>
            <AppButton variant="text" class="queue-clear" :title="t('清空队列，被清出的文本恢复回输入框')" @click="onClearQueue">{{ t('清空') }}</AppButton>
          </div>

          <!-- 一体容器：正文在上、操作条在下，外框只出现一次（与落地页同一组件） -->
          <ComposerShell class="input-wrap">
            <template #tray>
              <div v-if="pendingAttachments.length" class="att-tray">
                <div v-for="a in pendingAttachments" :key="a.id" class="att-chip" :class="a.kind">
                  <img v-if="a.kind === 'image'" :src="a.src" class="att-thumb" alt="" />
                  <AppIcon v-else :name="attachmentIcon(a.name)" :size="16" />
                  <span class="att-body">
                    <span class="att-name" :title="a.path">{{ a.name }}</span>
                    <span class="att-meta">{{ attachmentMeta(a) }}</span>
                  </span>
                  <AppButton type="button" variant="icon" class="att-x" :title="t('移除附件')" @click="removeAttachment(a.id)">
                    <AppIcon name="close" :size="12" />
                  </AppButton>
                </div>
              </div>
            </template>

            <AppTextarea
              v-model="draft"
              :placeholder="t('给 Pi 下达编码任务…（可附带图片或文件）')"
              :rows="1"
              auto-grow
              :max-rows="8"
              @keydown.enter="onEnter"
            />

            <template #left>
              <AppButton
                type="button"
                variant="icon"
                class="attach"
                :title="IN_TAURI ? t('附带图片或文件') : t('附件需在桌面 App 中使用')"
                :disabled="!IN_TAURI"
                @click="onAttach"
              >
                <AppIcon name="paperclip" :size="16" />
              </AppButton>
              <!-- G6 插话：仅流式中且有草稿时出现，steer 注入当前轮。 -->
              <AppButton
                v-if="streaming && (draft.trim() || pendingAttachments.length)"
                type="button"
                variant="icon"
                class="steer"
                :title="t('插话：本轮工具跑完后、下次模型调用前注入（steer）')"
                @click="onSteer"
              >
                <AppIcon name="zap" :size="14" />
              </AppButton>
              <!-- 与落地页同一处：模型 / 思考档 / 专家角色都贴在输入框上，顶栏不再重复 -->
              <div class="composer-meta">
                <ModelSwitcher compact width="auto" />
                <ModeSwitcher :model-value="thinkingLevel" width="auto" @update:model-value="setMode" />
                <RoleSwitcher :root="cwd" width="auto" />
                <ExpertPicker v-model="expertQueue" width="auto" />
              </div>
            </template>

            <template #right>
              <ComposerStatus class="composer-tools-status" :state="activity" :running="streaming" />
              <!-- 发送 / 停止同一位置切换：运行中这个位置永远是停止。 -->
              <AppButton
                v-if="streaming"
                type="button"
                class="stop"
                :title="t('停止本轮')"
                @click="abort"
              >
                <AppIcon name="stop" :size="14" />
              </AppButton>
              <AppButton
                v-else
                type="submit"
                variant="primary"
                class="send"
                :title="t('发送')"
                :disabled="(!draft.trim() && pendingAttachments.length === 0) || !cwd"
              >
                <AppIcon name="send" :size="15" />
              </AppButton>
            </template>
          </ComposerShell>
        </form>
      </template>
    </section>

    <!--
      文件树 / 终端 / 浏览器不再常驻这一页：它们是「进项目」之后的工具，
      归项目详情页（`/projects/:id`）。对话页只留一条按需展开的过程抽屉。
    -->
    <TraceDrawer
      v-if="!showHero"
      :open="traceOpen"
      :calls="trackCalls"
      :state="activity"
      :running="streaming"
      :messages="messages"
      :session-id="PI_SESSION_ID"
      :usage="usage.last"
      :turns="chatCounts.turns"
      :steps="chatCounts.steps"
      :project-id="activeProjectId"
      @close="traceOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { t } from '@/i18n'
import { computed, onMounted, onUnmounted, provide, ref, watch } from 'vue'
import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { open as pickFiles } from '@tauri-apps/plugin-dialog'
import { useRoute } from 'vue-router'
import MessageList from '@/components/chat/MessageList.vue'
import ApprovalDialog from '@/components/chat/ApprovalDialog.vue'
import ComposerStatus from '@/components/chat/ComposerStatus.vue'
import ComposerShell from '@/components/chat/ComposerShell.vue'
import ChatHero from '@/components/chat/ChatHero.vue'
import ModeSwitcher from '@/components/chat/ModeSwitcher.vue'
import ModelSwitcher from '@/components/chat/ModelSwitcher.vue'
import WorkspacePicker from '@/components/chat/WorkspacePicker.vue'
import TraceDrawer from '@/components/chat/TraceDrawer.vue'
import RoleSwitcher from '@/components/layout/RoleSwitcher.vue'
import ExpertPicker from '@/components/chat/ExpertPicker.vue'
import { expertsList } from '@/composables/useExperts'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppTextarea from '@/components/ui/AppTextarea.vue'
import { IN_TAURI, usePi, type PiAttachment } from '@/composables/usePi'
import { fmtCost, fmtTokens } from '@/composables/piEvents'
import { useArtifacts } from '@/composables/useArtifacts'
import { libraryArchiveSession } from '@/composables/useLibrary'
import { useActivity } from '@/composables/useActivity'
import { PI_EVENTS, usePiEvents } from '@/composables/usePiEvents'
import { shouldShowHero } from '@/composables/chatStage'
import { setThinkingMode, thinkingLevel } from '@/composables/useThinkingMode'
import { traceLog } from '@/composables/useWebLog'
import { pickDirectoryGuarded, PICK_TIMEOUT_NOTE } from '@/composables/useDirPicker'
import { trimPreamble } from '@/composables/contextBudget'
import { withTimeout } from '@/composables/asyncGuard'
import {
  activateProject,
  activeProjectId,
  createProject,
  indexProjectCodebase,
  loadActiveProject,
  PI_SESSION_ID,
  refreshCodebaseStatus,
  taskContextPreamble,
} from '@/composables/useProject'
import {
  exportConversation,
  importConversation,
  type ConvMessage,
} from '@/composables/useConversationIO'
import {
  activeReplayIndex,
  loadReplay,
  parseReplayQuery,
  pendingReplayIndex,
} from '@/composables/useReplay'
import { buildExecPrompt, withPlanInstruction } from '@/utils/planMode'
import { attachmentIcon, attachmentMeta } from '@/utils/attachmentMeta'
import { useRunFocus } from '@/composables/useRunFocus'

const { messages, streaming, usage, ensure, start, stop, send, noteUser, pushUser, pushSystem, rpc, abortTurn, suppressExitNotice, beginTurn, rewindTurn, planPending, queue, followUp, steerTurn, clearQueue } = usePi()

const cwd = ref('')
/** 路由 query：独立回放窗口的 replay 段号 / cwd 从这里读（见 consumeReplayQuery）。 */
const route = useRoute()
/** 过程抽屉（会话树 / 轨迹 / 工作流 / 连接器）是否展开。 */
const traceOpen = ref(false)
const { focusSeq } = useRunFocus()
const { state: activity, interrupt } = useActivity(messages, streaming)

/** 会话迁移操作的瞬时提示（导出去向 / 导入结果 / 错误）。 */
const ioNote = ref('')
let ioTimer: ReturnType<typeof setTimeout> | null = null
function flashIoNote(text: string) {
  ioNote.value = text
  if (ioTimer) clearTimeout(ioTimer)
  ioTimer = setTimeout(() => (ioNote.value = ''), 3500)
}

/** 把前端 PiMsg 映射成可序列化会话消息（丢弃流式/用量等运行时态，保留附件引用）。 */
function toConv(
  messages: {
    id: string
    role: any
    text: string
    tool?: string
    attachments?: { id: string; name: string; kind: 'image' | 'file'; path: string }[]
  }[],
): ConvMessage[] {
  return messages.map((m) => ({
    id: m.id,
    role: m.role,
    text: m.text,
    tool: m.tool,
    ...(m.attachments?.length ? { attachments: m.attachments } : {}),
  }))
}

async function onExport() {
  try {
    const res = await exportConversation(toConv(messages.value), 'pi-workbench-conversation')
    if (res === 'clipboard') flashIoNote(t('已复制到剪贴板（浏览器模式）'))
    else if (res === 'cancelled') return
    else flashIoNote(t('已导出到 {0}', [res]))
  } catch (e: any) {
    flashIoNote(t('导出失败：{0}', [e?.message ?? e]))
  }
}

async function onImport() {
  try {
    const imported = await importConversation()
    messages.value = imported.map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      tool: m.tool,
      ...(m.attachments?.length ? { attachments: m.attachments } : {}),
    }))
    flashIoNote(t('已导入 {0} 条消息', [imported.length]))
  } catch (e: any) {
    if (e?.message === 'cancelled') return
    flashIoNote(t('导入失败：{0}', [e?.message ?? e]))
  }
}

// 会话级事件流：轨迹面板与智能体浏览器共享一条订阅，避免重复消费同一事件。
const piEvents = usePiEvents(300)
provide(PI_EVENTS, piEvents)
onMounted(() => {
  void piEvents.ensure()
  // 接力提示要用专家名，而不是裸 id。
  void expertsList()
    .then((list) => {
      expertNames.value = Object.fromEntries(list.map((e) => [e.id, e.name]))
    })
    .catch(() => {})
})

/**
 * 落地页 or 会话流。
 *
 * 判据只看「有没有消息」——**不看工作目录**。选完项目仍然停在落地页，
 * 用户按下回车、消息进列表之后才切到会话流（详见 `@/composables/chatStage`）。
 */
const showHero = computed(() => shouldShowHero(messages.value.length, streaming.value))

/** 气泡下「运行链路」入口 → 展开过程抽屉；图在轨迹页签里渲染（见 TraceDrawer）。 */
watch(focusSeq, () => {
  if (!showHero.value) traceOpen.value = true
})

/**
 * dsh 式统计行的两个计数：轮次 = 用户消息条数，步数 = 带工具的消息条数。
 * 放在 ChatView 而不是 ComposerStatus 里，是为了不让状态条反过来依赖消息列表
 * （它只管输入框附近的状态，数据由上层喂）。
 */
const chatCounts = computed(() => ({
  turns: messages.value.filter((m) => m.role === 'user').length,
  steps: messages.value.filter((m) => m.tool).length,
}))

/**
 * 本轮是否被用户中止（dsh 中断收据的数据源）。MessageList 只在「末尾 turn +
 * 这个标记为真」时渲染「已中断」；下一轮开始流式即清零，不会串到别的轮次上。
 */
const abortedTurn = ref(false)
watch(
  streaming,
  (on, was) => {
    if (on && !was) abortedTurn.value = false
  },
)

/**
 * G1 中断本轮：优先内核原生 `abort`（优雅中止，进程/会话树/上下文全保留）；
 * 仅当内核已无应答（abort 自身失败）才退回复古的 `pi_stop` 杀进程兜底，
 * 并抑制伴生的「内核进程已退出」系统消息——那是用户主动停的，不该报警。
 */
async function abort() {
  // 用户主动中断：接力队列一起作废，别在停手后自动换下一位继续跑。
  relayRemaining.value = []
  relayPrev.value = ''
  interrupt()
  try {
    await abortTurn()
    abortedTurn.value = true
    traceLog('abort:graceful')
  } catch (e) {
    traceLog('abort:fallback-stop', String(e))
    suppressExitNotice()
    await stop().catch(() => {})
  }
}

const draft = ref('')
const projects = ref<{ id: string; name: string; path: string | null }[]>([])

/** 首页「先选目录再发送」的暂存文本（见 `submitHero`）。 */
const pendingHero = ref('')
/** 父级正在拉起目录选择器：只用于让 Hero 显示等待态。 */
const heroPicking = ref(false)
/** 非阻塞提示：不再用 `alert()` 打断（Tauri 里会卡住整个 webview）。 */
const notice = ref('')
let noticeTimer: ReturnType<typeof setTimeout> | null = null

function warn(msg: string) {
  notice.value = msg
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => {
    notice.value = ''
    noticeTimer = null
  }, 6000)
}

/**
 * 多模态输入侧：选图/文件 → 落盘到 app_config_dir/attachments → 缩略图预览 →
 * 发送时把路径引用块交给 Pi。Pi RPC 当前只接受字符串 prompt，故走引用路径绕行。
 * 浏览器模式下无 Tauri IPC，附件能力不可用，按钮置灰并提示。
 */
interface PendingAttachment {
  id: string
  name: string
  kind: 'image' | 'file'
  path: string
  size?: number
  /** Tauri webview 里显示本地图需经 convertFileSrc 转成可加载的 src。 */
  src: string
}

const pendingAttachments = ref<PendingAttachment[]>([])

/** 发送载荷只带内核/回放需要的字段，不把 webview src 写进 journal。 */
function attachmentsPayload(): PiAttachment[] {
  return pendingAttachments.value.map(({ id, name, kind, path, size }) => ({ id, name, kind, path, size }))
}

function isImageName(name: string) {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)
}

async function onAttach() {
  if (!IN_TAURI) {
    warn(t('附件需要桌面 App：请运行 npm run app:dev 启动后再用'))
    return
  }
  const selected = await pickFiles({
    multiple: true,
    title: t('选择要附带的图片或文件'),
  })
  if (!selected || selected.length === 0) return
  const paths = Array.isArray(selected) ? selected : [selected]
  for (const p of paths) {
    try {
      // 复制进托管目录：用户原文件可能被删/移动，落盘副本更稳。
      const info = await invoke<{ path: string; name: string; size: number }>('attachment_add', { src: p })
      pendingAttachments.value.push({
        id: `att${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name: info.name,
        kind: isImageName(info.name) ? 'image' : 'file',
        path: info.path,
        size: info.size,
        src: convertFileSrc(info.path),
      })
    } catch (e: any) {
      warn(t('附件添加失败：{0}', [e?.message ?? e]))
    }
  }
}

function removeAttachment(id: string) {
  pendingAttachments.value = pendingAttachments.value.filter((a) => a.id !== id)
}

/** 轨迹 tab 徽标：内核真实上报的工具调用次数（stats 是 computed，模板不自动解包）。 */
const trackCalls = computed(() => piEvents.stats.value.calls)

/**
 * 本轮 agent 步骤（F6：聚合为一行）。
 *
 * 轨迹抽屉默认是收起的，但「agent 现在在干什么」不该藏起来 —— 用户要的是
 * 对话区就能看见轨迹。之前是一排重复的 `⚡bash` chip（同名各占一格、只留最近
 * 4 条），信息密度低又跨轮串台；现在按「最后一次 turn_start 之后」取本轮工具
 * 调用，同名合并计数，右槽给总步数与累计时长。
 * 时长直接用内核事件已有的 `at`（到达毫秒）首尾相减，不新增状态通道。
 */
const runToolCalls = computed(() => {
  const evs = piEvents.events.value
  let start = 0
  for (let i = evs.length - 1; i >= 0; i--) {
    if (evs[i].kind === 'turn_start') {
      start = i
      break
    }
  }
  return evs.slice(start).filter((e) => e.kind === 'tool_call')
})

/** 同名工具合并计数，按次数从多到少；上限 6 组，再多就只留在轨迹抽屉里。 */
const stepGroups = computed(() => {
  const map = new Map<string, { title: string; count: number; detail: string }>()
  for (const e of runToolCalls.value) {
    const hit = map.get(e.title)
    if (hit) hit.count += 1
    else map.set(e.title, { title: e.title, count: 1, detail: e.detail })
  }
  return [...map.values()].sort((a, b) => b.count - a.count).slice(0, 6)
})

const stepTotal = computed(() => runToolCalls.value.length)

/** 本轮累计时长（<1 步没有区间，返回空串由模板隐藏）。 */
const runSpanText = computed(() => {
  const cs = runToolCalls.value
  if (cs.length < 2) return ''
  const s = Math.max(0, cs[cs.length - 1].at - cs[0].at) / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
})

const stepsVisible = computed(() => streaming.value || stepTotal.value > 0)

const { byMessage: artifacts, scan: scanArtifacts, auto: autoArtifacts } = useArtifacts(cwd)

/* ── 会话产物自动归档 ────────────────────────────────────────
 * 触发点：每次运行落定（streaming true → false），成功与失败都走这里。
 * 归档是旁路：任何错误只提示，不改变会话状态。 */
let archiveArmed = false

function localDate(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

async function archiveArtifacts() {
  try {
    // 落定后补扫一次：auto 扫描有 500ms 防抖，这里要拿最新结果。
    await scanArtifacts(messages.value)
    const paths = [...new Set(Object.values(artifacts.value).flat().map((a) => a.path))]
    if (!paths.length) return
    const title =
      (messages.value.find((m) => m.role === 'user')?.text ?? '').trim().slice(0, 40) ||
      t('会话')
    const report = await libraryArchiveSession(PI_SESSION_ID, title, localDate(), paths)
    if (report.failed) warn(t('资料库自动归档失败，可在资料库重试'))
  } catch {
    // 归档失败不能影响会话本身：提示留在顶部，会话继续可用。
    warn(t('资料库自动归档失败，可在资料库重试'))
  }
}
let stopArtifacts: (() => void) | null = null

/**
 * 载入项目清单与活动项目。
 *
 * 顺序不能反：活动项目一变就会触发下面的 watcher，而 watcher 要在本地清单里
 * 查这个项目的目录 —— 清单还没就位的话，它只能当「查不到」处理。
 */
async function loadActive() {
  projects.value = await invoke<any[]>('projects_list').catch(() => [])
  await loadActiveProject()
  // 重新挂载时活动项目往往**没变**（共享 ref 不变 → watcher 不触发），
  // 所以这里必须自己补一次，否则从项目页回到对话页就会停在空白首页。
  await syncCwdFromActive(activeProjectId.value)
}

/** 切活动项目：走共享状态，Sidebar 里点的和这里点的是同一条路。 */
async function setActiveProject(id: string) {
  await activateProject(id)
}

/**
 * 活动项目 → 工作目录。
 *
 * 没有目录的项目**不能静默成功** —— 那正是「换了项目但界面毫无反应」的来源：
 * 直接拉起目录选择器给它绑一个，用户点一下就有了下一条可走的路。
 */
async function syncCwdFromActive(id: string | null) {
  const p = projects.value.find((x) => x.id === id)
  if (!p) return
  if (p.path) {
    cwd.value = p.path
    await maybeIndexProject(id)
    return
  }
  // 已经在问用户要目录了就别重复弹（watcher 与挂载时的那次会撞在一起）
  if (heroPicking.value) return
  warn(t('项目「{0}」还没有工作目录，选一个文件夹后就能开工。', [p.name]))
  await pickHeroDirectory(p.id)
}

watch(activeProjectId, (id) => {
  void syncCwdFromActive(id)
})

/**
 * 项目落到有目录之后：先读后端落库的索引状态，只有「从未索引过」（none）
 * 才真正去遍历文件并生成 codebase-memory-mcp 的索引 db —— 这是用户之前
 * 最在意的「只转圈、不干活」问题的正解。已索引/失败过的都不会重复触发。
 */
async function maybeIndexProject(id: string | null) {
  if (!id) return
  const status = await refreshCodebaseStatus(id).catch(() => null)
  if (status && status.status === 'none') {
    void indexProjectCodebase(id).catch((e) => warn(t('代码库索引失败：{0}', [String(e)])))
  }
}

/** 已有项目补绑目录：落库 → 本地清单同步 → 激活。 */
async function onBindDirectory(payload: { id: string; dir: string }) {
  try {
    await invoke('project_set_path', { id: payload.id, path: payload.dir })
    const p = projects.value.find((x) => x.id === payload.id)
    if (p) p.path = payload.dir
    await activateProject(payload.id)
    // 绑定的就是当前活动项目时 id 没变，watcher 不会再触发 —— 这里直接落定。
    cwd.value = payload.dir
    // 换目录 = 换工作区，必须重新建索引（旧的索引已对不上新目录）。
    void indexProjectCodebase(payload.id).catch((e) => warn(t('代码库索引失败：{0}', [String(e)])))
  } catch (e) {
    warn(t('绑定工作目录失败：{0}', [String(e)]))
  }
}

async function onPickDirectory(dir: string) {
  if (!dir) return
  const name = dir.replace(/\\/g, '/').split('/').filter(Boolean).pop() || t('新项目')
  try {
    const snapshot = await createProject(name, '', undefined, dir)
    const p = {
      id: snapshot.project.id,
      name: snapshot.project.name,
      path: snapshot.project.path || dir,
    }
    if (!projects.value.some((x) => x.id === p.id)) {
      projects.value.push(p)
    }
    await setActiveProject(p.id)
  } catch (e) {
    warn(t('创建项目失败：{0}', [String(e)]))
  }
}

/**
 * 首页发送。
 *
 * 未绑定工作目录时**不拦着用户打字**：把这句话先记下来，拉起目录选择器，
 * 选完目录登记成项目，`watch(cwd)` 里把这句补发出去。
 * 这段编排必须放在本组件 —— 首页 Hero 在 `cwd` 一旦就位就会卸载，
 * 它自己没有机会「选完再发」。
 */
async function submitHero(text: string) {
  if (!cwd.value) {
    pendingHero.value = text
    await pickHeroDirectory()
    return
  }
  await dispatchToPi(text)
}

/**
 * 父级侧的目录选择：Hero 靠 `busy` 显示「正在选择…」。
 *
 * `bindProjectId` 有值 = 给这个已有项目补绑目录（项目本来就没有目录），
 * 没值 = 新建一个「本地目录」项目。两条路共用同一套超时/取消兜底。
 */
async function pickHeroDirectory(bindProjectId?: string) {
  if (heroPicking.value) return
  heroPicking.value = true
  try {
    const { dir, timedOut } = await pickDirectoryGuarded()
    if (timedOut) {
      pendingHero.value = ''
      warn(PICK_TIMEOUT_NOTE())
      return
    }
    if (!dir) {
      pendingHero.value = ''
      warn(t('没有选择工作目录。'))
      return
    }
    if (bindProjectId) {
      await onBindDirectory({ id: bindProjectId, dir })
      return
    }
    await onPickDirectory(dir)
  } finally {
    heroPicking.value = false
  }
}

/** 下发到内核：项目上下文前缀（预算裁剪后）+ 用户原文 + 附件引用块。 */
/**
 * 专家接力：勾选顺序即执行顺序。第一位随本轮 prompt 下发，
 * 之后每轮落定（streaming=false）把上一位产出作为下一位的输入再发。
 * 取消/中断时清空队列，避免停了之后还自动续跑。
 */
const expertQueue = ref<string[]>([])
const relayRemaining = ref<string[]>([])
const relayPrev = ref('')
const expertNames = ref<Record<string, string>>({})

function expertLabel(id: string) {
  return expertNames.value[id] ?? id
}

async function runRelay() {
  const [next, ...rest] = relayRemaining.value
  if (!next) return
  const from = relayPrev.value
  relayRemaining.value = rest
  relayPrev.value = next
  const last = [...messages.value]
    .reverse()
    .find((m) => m.role === 'assistant' && m.text?.trim())
  if (!last?.text?.trim()) {
    pushSystem(t('交接中止：上一位专家没有产出'))
    relayRemaining.value = []
    return
  }
  pushSystem(t('交接：{0} → {1}', [from ? expertLabel(from) : t('上一位'), expertLabel(next)]))
  const body = `${t('上一位专家的产出：')}\n\n${last.text.trim()}\n\n${t('请在此基础上继续。')}`
  try {
    await send(body, undefined, { id: next, handoffFrom: from || undefined })
    traceLog('expert:relay', `${from}->${next}`)
  } catch (e) {
    pushSystem(t('交接失败：{0}', [String(e)]))
    relayRemaining.value = []
  }
}

watch(streaming, (on) => {
  if (!on) void runRelay()
})

// 运行落定才归档：回放/初始化时 streaming 一直是 false，不会误触发。
watch(streaming, (on) => {
  if (on) {
    archiveArmed = true
    return
  }
  if (!archiveArmed) return
  archiveArmed = false
  void archiveArtifacts()
})

async function dispatchToPi(
  text: string,
  attachments?: PiAttachment[],
  experts?: string[],
) {
  const [firstExpert, ...restExperts] = experts ?? []
  relayRemaining.value = restExperts
  relayPrev.value = firstExpert ?? ''
  traceLog('dispatch', text.slice(0, 50))
  // 乐观 UI：用户消息**先**落列表、落地页立刻切走。前缀收集是锦上添花，
  // 它若挂起（invoke 遇主线程被堵可能永不返回），绝不能挡住「消息至少看得见」——
  // 之前 pushUser 排在 await 之后，卡住时表现为「终端有日志、页面毫无反应」。
  pushUser(text, attachments)
  // 先落 journal 再收前缀：这段窗口内刷新 / 切会话，回放仍能还原这条消息。
  // 落盘失败也不阻断——send 会自行合成（journaled=false 时不跳过）。
  const noted = await noteUser(text, attachments)
  // 前缀收集加硬超时：3.5s 拿不到就空前缀发送。上下文少了可以忍，界面卡死不能忍。
  const rawPreamble = await withTimeout(taskContextPreamble(), 3_500, '').catch(() => '')
  const { preamble } = trimPreamble(rawPreamble)
  const body = preamble ? `${preamble}\n\n---\n\n${text}` : text
  // G5：plan 模式——指令前缀拼在最外（preamble 之前，回放时被 `---` 切分剥掉），
  // 同时挂上待确认计划；该轮 assistant 回复落定时解析成计划卡。
  // 注意 user 气泡仍显示原文（pushUser 在上面已用 text 落过），不露指令。
  const finalBody = planMode.value ? withPlanInstruction(body) : body
  if (planMode.value) planPending.value = { task: text }
  // G3：开轮快照（Rust 记会话树叶子 + 打 marker），seq 挂到刚 push 的 user 消息上。
  // 失败不阻断发送——少一次回滚机会可以忍，消息发不出去不能忍。
  const turnSeq = await beginTurn(text)
  const userMsg = messages.value[messages.value.length - 1]
  if (turnSeq > 0 && userMsg && userMsg.role === 'user') userMsg.turnSeq = turnSeq
  try {
    await send(finalBody, attachments, firstExpert ? { id: firstExpert } : undefined, noted)
    traceLog('dispatch:sent')
  } catch (e) {
    const msg = String(e)
    // 内核已死（process_exit 之后）不该让用户手动救：自动拉起再补发一次。
    if (msg.includes(t('pi 未启动')) && cwd.value) {
      traceLog('dispatch:kernel-restart')
      try {
        await start(cwd.value)
        await send(finalBody, attachments, firstExpert ? { id: firstExpert } : undefined, noted)
        traceLog('dispatch:sent:after-restart')
        return
      } catch (e2) {
        pushSystem(t('内核自动重启后仍下发失败：{0}', [String(e2)]))
        warn(String(e2))
        traceLog('dispatch:fail', String(e2))
        return
      }
    }
    // 失败必须落进消息流：只在顶部飘一条 6 秒 notice，用户看到的就是「点了没反应」。
    pushSystem(t('内核未响应：{0}', [msg]))
    warn(msg)
    traceLog('dispatch:fail', msg)
  }
}

/**
 * G3「回到此处」：确认后还原该轮 edit/write 改过的文件 + fork 会话树到该
 * prompt 之前，前端消息列表从该条 user 消息起截断（prompt 重新可编辑/重发）。
 * 边界：bash 产生的变更不在快照范围（对齐 Claude Code checkpoint 明示限制），
 * 确认框与结果消息里都要写清楚。
 */
const rewinding = ref(false)
const rewindTarget = ref<{ id: string; turnSeq: number; text: string } | null>(null)

function onRewindRequest(msg: { id: string; turnSeq?: number; text: string }) {
  const seq = msg.turnSeq
  if (!seq || rewinding.value) return
  rewindTarget.value = { id: msg.id, turnSeq: seq, text: msg.text }
}

async function onRewindConfirm() {
  const target = rewindTarget.value
  if (!target) return
  rewinding.value = true
  try {
    const rep = await rewindTurn(target.turnSeq)
    const idx = messages.value.findIndex((m) => m.id === target.id)
    if (idx >= 0) messages.value.splice(idx)
    const parts: string[] = []
    parts.push(
      rep.restored.length
        ? t('已还原 {0} 个文件', [rep.restored.length])
        : t('该轮没有改动过文件'),
    )
    parts.push(
      rep.fork_entry_id ? t('会话已重开到该消息处（新分支）') : t('会话树未能重开（仅还原了文件）'),
    )
    if (rep.failed.length) parts.push(t('{0} 项失败：{1}', [rep.failed.length, rep.failed.join('；')]))
    pushSystem(t('已回到第 {0} 轮之前：{1}。', [target.turnSeq, parts.join('；')]))
    traceLog('rewind:done', String(target.turnSeq))
  } catch (e) {
    pushSystem(t('回滚失败：{0}', [String(e)]))
    traceLog('rewind:fail', String(e))
  } finally {
    rewinding.value = false
    rewindTarget.value = null
  }
}

/**
 * G5「开始执行」：批准计划 → 关掉 plan 模式（执行轮再注入计划指令会无限
 * 循环出计划）→ 把「已批准步骤 + 原始任务」作为新 prompt 下发。
 * 执行 prompt 走完整 dispatchToPi：该轮同样有 checkpoint 与 turn 记账。
 */
function onPlanExecute(m: {
  id: string
  plan?: { steps: string[]; task: string; state: 'pending' | 'executing' }
}) {
  if (!m.plan || m.plan.state !== 'pending' || streaming.value) return
  m.plan.state = 'executing'
  planMode.value = false
  void dispatchToPi(buildExecPrompt(m.plan.task, m.plan.steps))
  traceLog('plan:execute', String(m.plan.steps.length))
}

/**
 * G5「修改计划」：步骤回填输入框，plan 模式保持开启——
 * 用户改完再发仍是计划请求（出一版新计划卡），不会误触发执行。
 */
function onPlanRevise(m: {
  id: string
  plan?: { steps: string[]; task: string; state: 'pending' | 'executing' }
}) {
  if (!m.plan || m.plan.state !== 'pending') return
  draft.value = m.plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
}

/**
 * B3 压缩：内核原生 session.compact——把已发生的轮次摘要化回灌，
 * 释放上下文窗口。长操作，超时放宽到 120s；结果摘要落消息流让用户看到效果。
 */
const compacting = ref(false)
async function onCompact() {
  if (compacting.value || streaming.value) return
  compacting.value = true
  try {
    const res = await rpc<any>('compact', {}, 120_000).catch((e) => {
      throw e
    })
    const summary = typeof res === 'string' ? res : res?.summary ?? res?.text ?? ''
    pushSystem(
      summary
        ? t('会话已压缩。摘要：{0}', [String(summary).slice(0, 200)])
        : t('会话已压缩，上下文窗口已释放。'),
    )
    traceLog('compact:done')
  } catch (e) {
    pushSystem(t('压缩失败：{0}', [String(e)]))
    traceLog('compact:fail', String(e))
  } finally {
    compacting.value = false
  }
}

async function submit() {
  const text = draft.value.trim()
  // 允许「只发附件、不写正文」（例如「分析这张截图」直接带图）。
  if (!text && pendingAttachments.value.length === 0) return
  if (!cwd.value) {
    warn(t('请先在「项目」中添加并选中一个活动项目'))
    return
  }
  const atts = attachmentsPayload()
  draft.value = ''
  pendingAttachments.value = []
  // G6：流式中提交 = 入队（内核 follow_up，本轮完全结束后自动执行），
  // 消息气泡照落——对话流连续，队列 chip 另行提示「排队中」。
  if (streaming.value) {
    pushUser(text, atts)
    try {
      await followUp(text, atts)
      traceLog('queue:follow-up', text.slice(0, 40))
    } catch (e) {
      pushSystem(t('入队失败：{0}', [String(e)]))
    }
    return
  }
  // 专家是一次性选择：发出去就清空，避免下一条普通消息误挂专家策略。
  const experts = expertQueue.value.slice()
  expertQueue.value = []
  await dispatchToPi(text, atts, experts)
}

/**
 * G6「插话」：steer 注入当前轮（工具跑完后、下次 LLM 调用前生效），
 * 把跑偏的 agent 拽回当前输入。同样落 user 气泡保持对话连续。
 */
async function onSteer() {
  const text = draft.value.trim()
  if (!text || !streaming.value || !cwd.value) return
  const atts = attachmentsPayload()
  draft.value = ''
  pendingAttachments.value = []
  pushUser(text, atts)
  try {
    await steerTurn(text, atts)
    traceLog('queue:steer', text.slice(0, 40))
  } catch (e) {
    pushSystem(t('插话失败：{0}', [String(e)]))
  }
}

/** G6「清空队列」：内核双清，被清出的文本恢复回编辑器——清空不该让用户白打一遍字。 */
async function onClearQueue() {
  try {
    const cleared = await clearQueue()
    const restored = [...(cleared?.steering ?? []), ...(cleared?.followUp ?? [])]
    if (restored.length && !draft.value.trim()) {
      draft.value = restored.join('\n')
    }
    traceLog('queue:clear', String(restored.length))
  } catch (e) {
    pushSystem(t('清空队列失败：{0}', [String(e)]))
  }
}

/**
 * 回车发送，但**中文/日文输入法合成期间要放行**。
 *
 * 合成未结束时按回车是「确认候选词」，键码为 229、`isComposing=true`；
 * 这时若 `.prevent` 掉默认行为并清空输入框，输入法的 run loop 会被打断，
 * macOS 报 `IMKCFRunLoopWakeUpReliable`，输入框随后卡死。所以合成中直接 return，
 * 让输入法自己把中文提交进 `draft`，真正的发送在合成结束后的那次回车触发。
 */
function onEnter(e: KeyboardEvent) {
  if (e.isComposing || (e as KeyboardEvent & { keyCode?: number }).keyCode === 229) return
  e.preventDefault()
  void submit()
}

watch(cwd, async (v) => {
  if (!v) return
  const startedAt = performance.now()
  // 启动失败不能静默：静默之后用户点发送就是「毫无反应」，且无从排查。
  await start(v).catch((e) => {
    warn(t('Pi 内核启动失败：{0}', [String(e)]))
    traceLog('kernel:start-fail', String(e))
  })
  traceLog('boot:kernel-start', `${Math.round(performance.now() - startedAt)}ms`)
  traceLog('kernel:started', v)
  // 内核重启后 thinking level 会回到默认，落一次当前选择保持一致。
  await applyThinking()
  // 首页「先选目录再发送」：目录一就位就把暂存的那句补发出去。
  const pending = pendingHero.value
  pendingHero.value = ''
  if (pending) await dispatchToPi(pending)
})

/**
 * G5 计划模式：开启时发送的任务先带计划指令前缀（内核先出分步计划、不动工具），
 * 该轮回复落定后消息流渲染计划卡，用户点「开始执行」才发执行 prompt。
 * 与 thinking level 正交——一个管「想多深」，一个管「先审后做」。
 */
const planMode = ref(false)

/** G6：队列总数（steer 插话 + follow_up 排队），驱动 composer 上方队列 strip。 */
const queueTotal = computed(() => queue.value.steering.length + queue.value.followUp.length)

async function applyThinking() {
  if (!cwd.value) return
  await rpc('set_thinking_level', { level: thinkingLevel.value }).catch(() => {})
}

function setMode(mode: string) {
  setThinkingMode(mode)
  void applyThinking()
}

async function ensureDefaultRole() {
  if (!cwd.value) return
  const cur = await invoke<any | null>('role_current', { root: cwd.value }).catch(() => null)
  if (cur?.id) return
  await invoke('role_set', { id: 'general', root: cwd.value }).catch(() => {})
}

onMounted(async () => {
  // 首屏阶段打点：与 Rust 侧 [boot] 对齐，定位卡顿落在前端哪一段。
  const bootAt = performance.now()
  const bootMark = (stage: string) =>
    traceLog(`boot:${stage}`, `${Math.round(performance.now() - bootAt)}ms`)
  // 独立回放窗口：先消费 query 段号（权威目标），再做常规初始化。
  void consumeReplayQuery()
  await ensure()
  bootMark('ensure')
  await loadActive()
  bootMark('loadActive')
  await ensureDefaultRole()
  bootMark('defaultRole')
  stopArtifacts = autoArtifacts(messages, streaming)
  bootMark('mounted')
})

/**
 * G4：会话持久化回放。内核是 --no-session（内存态），但 journal 落了全量事件；
 * 开页按当前项目回放最近一次会话，刷新/重启 App 后对话不再从零开始。
 *
 * 挂载时项目可能还没加载完（loadActive 是异步的），用 watch(cwd) 覆盖三种时序：
 * 挂载即就绪 / 异步加载完 / 用户切项目。空回放不占坑——journal 可能属于
 * 切换后的项目；已 successful 回放过一次就不再重放（不把两个项目的对话混一起）。
 */
let replayDone = false
/**
 * 独立回放窗口（后端 open_replay_window 拉起，hash 路由带
 * `?replay=<段号>&cwd=<目录>`）已接管回放：此时挂载时的
 * tryReplay 必须让位——窗口里可能没有选中项目，而 query 给出的
 * 段号 + 目录才是权威目标，不能被活动项目的「最近一次会话」覆盖。
 */
let queryReplayActive = false
async function tryReplay() {
  const dir = cwd.value
  if (!dir || replayDone || queryReplayActive || messages.value.length > 0) return
  const rep = await loadReplay(undefined, dir)
  if (!rep.messages.length) return
  replayDone = true
  // 回放期间用户可能已经手动发了消息（极端快）：只补空列表，不覆盖。
  if (messages.value.length === 0) messages.value.push(...rep.messages)
}
watch(cwd, () => void tryReplay(), { immediate: true })

/**
 * 运行记录回放（WorkDSH「之前的运行记录」对位）：按 journal 段号重建历史会话，
 * 替换当前对话区。流式中禁止——半轮替换等于毁掉进行中的任务；
 * 手动回放后置 replayDone，挂载自动回放不再覆盖。
 */
const loadingHistory = ref(false)
async function openRunRecord(index: number) {
  if (streaming.value) {
    warn(t('本轮还在执行中，等它结束后再打开历史会话。'))
    return
  }
  if (loadingHistory.value) return
  loadingHistory.value = true
  try {
    const rep = await loadReplay(undefined, cwd.value || undefined, index)
    if (!rep.messages.length) {
      warn(t('这条记录没有可重建的消息（可能只剩内核启动标记）。'))
      return
    }
    replayDone = true
    messages.value = rep.messages
    activeReplayIndex.value = index
    traceLog('history:open', String(index))
  } finally {
    loadingHistory.value = false
  }
}

/**
 * 侧栏运行记录的跨组件信箱：侧栏塞段号（可能发生在本页挂载前），
 * 这里等 cwd 就位后消费——cwd 就位意味着活动项目已加载，回放的
 * 目录一致性校验才有意义。立即消费并清空，避免重复回放。
 */
watch(
  [pendingReplayIndex, cwd],
  ([index]) => {
    if (index === null || !cwd.value) return
    pendingReplayIndex.value = null
    void openRunRecord(index)
  },
  { immediate: true },
)

/**
 * 独立回放窗口消费：query 带 replay 段号时（有 cwd 用 query 的，没有
 * 退活动项目目录），直接走 loadReplay 按段重建——不等活动项目加载，
 * 窗口可能是为空项目/纯回放用途拉起的。与 pendingReplayIndex 信箱
 * 消费同一套回放入口（openRunRecord 的同款 guard 与 traceLog）。
 */
async function consumeReplayQuery() {
  const target = parseReplayQuery(route.query)
  if (!target) return
  queryReplayActive = true
  if (streaming.value) {
    warn(t('本轮还在执行中，等它结束后再打开历史会话。'))
    return
  }
  loadingHistory.value = true
  try {
    const rep = await loadReplay(undefined, target.cwd || cwd.value || undefined, target.index)
    if (!rep.messages.length) {
      warn(t('这条记录没有可重建的消息（可能只剩内核启动标记）。'))
      return
    }
    replayDone = true
    messages.value = rep.messages
    traceLog('history:open-window', String(target.index))
  } finally {
    loadingHistory.value = false
  }
}

onUnmounted(() => {
  stopArtifacts?.()
  stopArtifacts = null
})
</script>

<style src="./ChatView.css" scoped></style>
