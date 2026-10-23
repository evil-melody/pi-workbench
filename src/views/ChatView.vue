<template>
  <div class="chat" :class="{ hero: showHero }">
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
            <!-- 项目名与工作目录是同一件事：一个控件收口，头部不再排两段文本 -->
            <WorkspacePicker
              :projects="projects"
              :cwd="cwd"
              @pick-project="setActiveProject"
              @pick-directory="onPickDirectory"
              @bind-directory="onBindDirectory"
            />
            <span class="sep">·</span>
            <RoleSwitcher :root="cwd" width="auto" />
            <span class="sep">·</span>
            <ModeSwitcher :model-value="modeLabel" width="auto" @update:model-value="setMode" />
            <span class="sep">·</span>
            <ModelSwitcher compact width="auto" />
          </div>

          <div class="chat-controls">
        <!-- 过程（会话树 / 轨迹 / 工作流 / 连接器）默认收起：主内容永远是对话本身 -->
          <button
            class="trace-toggle"
            :class="{ on: traceOpen }"
            :title="traceOpen ? '收起过程面板' : '展开过程面板：会话树 / 轨迹 / 工作流 / 连接器'"
            @click="traceOpen = !traceOpen"
          >
            <AppIcon name="activity" :size="14" />
            <span>轨迹</span>
            <i v-if="trackCalls" class="trace-badge">{{ trackCalls }}</i>
          </button>

          <!-- G5 计划模式（对齐 Cursor Plan mode）：开启后发送的任务先出分步计划卡，
               点「开始执行」才真正动工具。 -->
          <button
            class="plan-toggle"
            :class="{ on: planMode }"
            :title="planMode ? '计划模式已开启：先出计划，确认后执行' : '开启计划模式：先审方案再动手'"
            @click="planMode = !planMode"
          >
            <AppIcon name="list" :size="13" />
            <span>计划</span>
          </button>

          <!-- 会话迁移：导出当前对话为 JSON / 导入历史会话。 -->
          <div class="io-group" role="group" aria-label="会话迁移">
            <!--
              B3 压缩：内核原生 session.compact（长会话摘要回灌），压缩后上下文窗口
              重新拿回空间；fork（分支）在会话树里，这里只放最常用的压缩。
            -->
            <button
              class="io-btn"
              :disabled="compacting || streaming"
              title="压缩当前会话：把历史轮次摘要化，释放上下文窗口空间"
              @click="onCompact"
            >
              <AppIcon name="layers" :size="13" :class="{ spin: compacting }" />
              <span>{{ compacting ? '压缩中…' : '压缩' }}</span>
            </button>
            <button class="io-btn" title="导出当前会话为 JSON 文件" @click="onExport">
              <AppIcon name="download" :size="13" />
              <span>导出</span>
            </button>
            <button class="io-btn" title="从 JSON 文件导入会话" @click="onImport">
              <AppIcon name="upload" :size="13" />
              <span>导入</span>
            </button>
          </div>
        </div>
        </header>

        <p v-if="ioNote" class="io-note" role="status">{{ ioNote }}</p>

        <p v-if="!IN_TAURI" class="nokernel">
          浏览器模式：Pi 内核未接入，对话不可用。请运行 <code>npm run app:dev</code> 启动桌面 App。
        </p>

        <MessageList
          :messages="messages"
          :streaming="streaming"
          :artifacts="artifacts"
          :root="cwd"
          @rewind="onRewindRequest"
          @plan-execute="onPlanExecute"
          @plan-revise="onPlanRevise"
        />

        <!--
          本轮 agent 轨迹：抽屉可以收起，但步骤本身要看得见 ——
          发出任务后如果只剩一个转圈，用户无从判断 agent 到底动没动。
        -->
        <div v-if="stepsVisible" class="step-strip" role="status">
          <span class="step-head">
            <AppIcon
              :name="streaming ? 'activity' : 'check-circle'"
              :size="12"
              :class="{ spin: streaming }"
            />
            <span>{{ streaming ? '执行中' : '本轮步骤' }}</span>
          </span>
          <span
            v-for="(s, i) in liveSteps"
            :key="i"
            class="step-chip"
            :title="s.detail"
          >
            <AppIcon name="zap" :size="11" />
            <span class="step-name">{{ s.title }}</span>
          </span>
          <span v-if="!liveSteps.length" class="step-muted">等待内核上报步骤…</span>
        </div>

        <!--
          B1 硬审批横幅：内核扩展拦截风险工具调用时在此等待用户批准。
          不回应则扩展侧超时 fail-closed（安全优先）。
        -->
        <ApprovalDialog />

        <!-- G3 回滚确认：还原文件 + 重开会话，均无法在 App 内撤销，须显式确认。 -->
        <AppModal :open="!!rewindTarget" title="回到此处？" size="sm">
          <p class="rewind-warn">
            将把第 {{ rewindTarget?.turnSeq }} 轮起改动的文件还原到该轮之前，并重开会话到这条消息处。
            之后的对话内容会被移除，<strong>此操作无法撤销</strong>。
          </p>
          <p class="rewind-note">
            注意：bash 命令产生的文件变更不在还原范围（对齐 Claude Code checkpoint 的限制）。
          </p>
          <template #footer>
            <button class="btn" :disabled="rewinding" @click="rewindTarget = null">
              取消
            </button>
            <button class="btn danger" :disabled="rewinding" @click="onRewindConfirm">
              {{ rewinding ? '还原中…' : '确认回滚' }}
            </button>
          </template>
        </AppModal>

        <form class="composer" @submit.prevent="submit">
          <div v-if="pendingAttachments.length" class="att-tray">
            <div v-for="a in pendingAttachments" :key="a.id" class="att-chip" :class="a.kind">
              <img v-if="a.kind === 'image'" :src="a.src" class="att-thumb" alt="" />
              <AppIcon v-else name="file" :size="16" />
              <span class="att-name" :title="a.path">{{ a.name }}</span>
              <button type="button" class="att-x" title="移除附件" @click="removeAttachment(a.id)">
                <AppIcon name="close" :size="12" />
              </button>
            </div>
          </div>
          <!--
            G6 队列 strip：流式中的提交进内核 follow_up 队列（本轮完全结束后
            自动执行）；插话（steer）在工具跑完、下次 LLM 调用前注入。
            队列内容以内核 queue_update 回推为权威，前端不维护副账。
          -->
          <div v-if="queueTotal > 0" class="queue-strip">
            <div v-if="queue.steering.length" class="queue-seg steer">
              <span class="queue-tag">插话</span>
              <span class="queue-hint">下一轮模型调用前注入</span>
              <span v-for="(t, i) in queue.steering" :key="'s' + i" class="queue-item" :title="t">{{ t }}</span>
            </div>
            <div v-if="queue.followUp.length" class="queue-seg followup">
              <span class="queue-tag">排队</span>
              <span class="queue-hint">本轮结束后执行</span>
              <span v-for="(t, i) in queue.followUp" :key="'f' + i" class="queue-item" :title="t">{{ t }}</span>
            </div>
            <button class="queue-clear" title="清空队列，被清出的文本恢复回输入框" @click="onClearQueue">
              清空
            </button>
          </div>
          <div class="input-wrap">
            <AppTextarea
              v-model="draft"
              placeholder="给 Pi 下达编码任务…（可附带图片或文件）"
              :rows="1"
              auto-grow
              :max-rows="8"
              @keydown.enter="onEnter"
            />
            <div class="composer-tools">
              <button
                type="button"
                class="attach"
                :title="IN_TAURI ? '附带图片或文件' : '附件需在桌面 App 中使用'"
                :disabled="!IN_TAURI"
                @click="onAttach"
              >
                <AppIcon name="paperclip" :size="16" />
              </button>
              <!-- G6 插话：仅流式中且有草稿时出现，steer 注入当前轮。 -->
              <button
                v-if="streaming && (draft.trim() || pendingAttachments.length)"
                type="button"
                class="steer"
                title="插话：本轮工具跑完后、下次模型调用前注入（steer）"
                @click="onSteer"
              >
                <AppIcon name="zap" :size="14" />
              </button>
              <ComposerStatus
                class="composer-tools-status"
                :state="activity"
                :running="streaming"
                :usage="usage.last"
                :project-id="activeProjectId"
                @interrupt="abort"
              />
              <button
                type="submit"
                class="send"
                :title="streaming ? '排队：本轮结束后自动执行' : '发送'"
                :disabled="(!draft.trim() && pendingAttachments.length === 0) || !cwd"
              >
                <AppIcon name="send" :size="15" />
              </button>
            </div>
          </div>
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
      @close="traceOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, provide, ref, watch } from 'vue'
import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { open as pickFiles } from '@tauri-apps/plugin-dialog'
import { useRoute } from 'vue-router'
import MessageList from '@/components/chat/MessageList.vue'
import ApprovalDialog from '@/components/chat/ApprovalDialog.vue'
import ComposerStatus from '@/components/chat/ComposerStatus.vue'
import ChatHero from '@/components/chat/ChatHero.vue'
import ModeSwitcher from '@/components/chat/ModeSwitcher.vue'
import ModelSwitcher from '@/components/chat/ModelSwitcher.vue'
import WorkspacePicker from '@/components/chat/WorkspacePicker.vue'
import TraceDrawer from '@/components/chat/TraceDrawer.vue'
import RoleSwitcher from '@/components/layout/RoleSwitcher.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppTextarea from '@/components/ui/AppTextarea.vue'
import { IN_TAURI, usePi, type PiAttachment } from '@/composables/usePi'
import { fmtCost, fmtTokens } from '@/composables/piEvents'
import { useArtifacts } from '@/composables/useArtifacts'
import { useActivity } from '@/composables/useActivity'
import { PI_EVENTS, usePiEvents } from '@/composables/usePiEvents'
import { shouldShowHero } from '@/composables/chatStage'
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
import { loadReplay, parseReplayQuery, pendingReplayIndex } from '@/composables/useReplay'
import { buildExecPrompt, withPlanInstruction } from '@/utils/planMode'

const { messages, streaming, usage, ensure, start, stop, send, pushUser, pushSystem, rpc, abortTurn, suppressExitNotice, beginTurn, rewindTurn, planPending, queue, followUp, steerTurn, clearQueue } = usePi()

const cwd = ref('')
/** 路由 query：独立回放窗口的 replay 段号 / cwd 从这里读（见 consumeReplayQuery）。 */
const route = useRoute()
/** 过程抽屉（会话树 / 轨迹 / 工作流 / 连接器）是否展开。 */
const traceOpen = ref(false)
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
    if (res === 'clipboard') flashIoNote('已复制到剪贴板（浏览器模式）')
    else if (res === 'cancelled') return
    else flashIoNote(`已导出到 ${res}`)
  } catch (e: any) {
    flashIoNote(`导出失败：${e?.message ?? e}`)
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
    flashIoNote(`已导入 ${imported.length} 条消息`)
  } catch (e: any) {
    if (e?.message === 'cancelled') return
    flashIoNote(`导入失败：${e?.message ?? e}`)
  }
}

// 会话级事件流：轨迹面板与智能体浏览器共享一条订阅，避免重复消费同一事件。
const piEvents = usePiEvents(300)
provide(PI_EVENTS, piEvents)
onMounted(() => {
  void piEvents.ensure()
})

/**
 * 落地页 or 会话流。
 *
 * 判据只看「有没有消息」——**不看工作目录**。选完项目仍然停在落地页，
 * 用户按下回车、消息进列表之后才切到会话流（详见 `@/composables/chatStage`）。
 */
const showHero = computed(() => shouldShowHero(messages.value.length, streaming.value))

/**
 * G1 中断本轮：优先内核原生 `abort`（优雅中止，进程/会话树/上下文全保留）；
 * 仅当内核已无应答（abort 自身失败）才退回复古的 `pi_stop` 杀进程兜底，
 * 并抑制伴生的「内核进程已退出」系统消息——那是用户主动停的，不该报警。
 */
async function abort() {
  interrupt()
  try {
    await abortTurn()
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
  /** Tauri webview 里显示本地图需经 convertFileSrc 转成可加载的 src。 */
  src: string
}

const pendingAttachments = ref<PendingAttachment[]>([])

function isImageName(name: string) {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)
}

async function onAttach() {
  if (!IN_TAURI) {
    warn('附件需要桌面 App：请运行 npm run app:dev 启动后再用')
    return
  }
  const selected = await pickFiles({
    multiple: true,
    title: '选择要附带的图片或文件',
  })
  if (!selected || selected.length === 0) return
  const paths = Array.isArray(selected) ? selected : [selected]
  for (const p of paths) {
    try {
      // 复制进托管目录：用户原文件可能被删/移动，落盘副本更稳。
      const dest = await invoke<string>('attachment_add', { src: p })
      const name = p.replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'file'
      pendingAttachments.value.push({
        id: `att${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        name,
        kind: isImageName(name) ? 'image' : 'file',
        path: dest,
        src: convertFileSrc(dest),
      })
    } catch (e: any) {
      warn(`附件添加失败：${e?.message ?? e}`)
    }
  }
}

function removeAttachment(id: string) {
  pendingAttachments.value = pendingAttachments.value.filter((a) => a.id !== id)
}

/** 轨迹 tab 徽标：内核真实上报的工具调用次数（stats 是 computed，模板不自动解包）。 */
const trackCalls = computed(() => piEvents.stats.value.calls)

/**
 * 本轮 agent 步骤：内核上报的工具调用，最近几条。
 *
 * 轨迹抽屉默认是收起的，但「agent 现在在干什么」不该藏起来 —— 用户要的是
 * 对话区就能看见轨迹，而不是先猜再点开面板。
 */
const liveSteps = computed(() =>
  piEvents.events.value.filter((e) => e.kind === 'tool_call').slice(-4),
)
const stepsVisible = computed(() => streaming.value || liveSteps.value.length > 0)

const { byMessage: artifacts, auto: autoArtifacts } = useArtifacts(cwd)
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
  warn(`项目「${p.name}」还没有工作目录，选一个文件夹后就能开工。`)
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
    void indexProjectCodebase(id).catch((e) => warn(`代码库索引失败：${String(e)}`))
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
    void indexProjectCodebase(payload.id).catch((e) => warn(`代码库索引失败：${String(e)}`))
  } catch (e) {
    warn(`绑定工作目录失败：${String(e)}`)
  }
}

async function onPickDirectory(dir: string) {
  if (!dir) return
  const name = dir.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '新项目'
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
    warn(`创建项目失败：${String(e)}`)
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
      warn(PICK_TIMEOUT_NOTE)
      return
    }
    if (!dir) {
      pendingHero.value = ''
      warn('没有选择工作目录。')
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
async function dispatchToPi(text: string, attachments?: PiAttachment[]) {
  traceLog('dispatch', text.slice(0, 50))
  // 乐观 UI：用户消息**先**落列表、落地页立刻切走。前缀收集是锦上添花，
  // 它若挂起（invoke 遇主线程被堵可能永不返回），绝不能挡住「消息至少看得见」——
  // 之前 pushUser 排在 await 之后，卡住时表现为「终端有日志、页面毫无反应」。
  pushUser(text, attachments)
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
    await send(finalBody, attachments)
    traceLog('dispatch:sent')
  } catch (e) {
    const msg = String(e)
    // 内核已死（process_exit 之后）不该让用户手动救：自动拉起再补发一次。
    if (msg.includes('pi 未启动') && cwd.value) {
      traceLog('dispatch:kernel-restart')
      try {
        await start(cwd.value)
        await send(finalBody, attachments)
        traceLog('dispatch:sent:after-restart')
        return
      } catch (e2) {
        pushSystem(`内核自动重启后仍下发失败：${String(e2)}`)
        warn(String(e2))
        traceLog('dispatch:fail', String(e2))
        return
      }
    }
    // 失败必须落进消息流：只在顶部飘一条 6 秒 notice，用户看到的就是「点了没反应」。
    pushSystem(`内核未响应：${msg}`)
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
        ? `已还原 ${rep.restored.length} 个文件`
        : '该轮没有改动过文件',
    )
    parts.push(
      rep.fork_entry_id ? '会话已重开到该消息处（新分支）' : '会话树未能重开（仅还原了文件）',
    )
    if (rep.failed.length) parts.push(`${rep.failed.length} 项失败：${rep.failed.join('；')}`)
    pushSystem(`已回到第 ${target.turnSeq} 轮之前：${parts.join('；')}。`)
    traceLog('rewind:done', String(target.turnSeq))
  } catch (e) {
    pushSystem(`回滚失败：${String(e)}`)
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
        ? `会话已压缩。摘要：${String(summary).slice(0, 200)}`
        : '会话已压缩，上下文窗口已释放。',
    )
    traceLog('compact:done')
  } catch (e) {
    pushSystem(`压缩失败：${String(e)}`)
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
    warn('请先在「项目」中添加并选中一个活动项目')
    return
  }
  const atts: PiAttachment[] = pendingAttachments.value.map((a) => ({
    id: a.id,
    name: a.name,
    kind: a.kind,
    path: a.path,
  }))
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
      pushSystem(`入队失败：${String(e)}`)
    }
    return
  }
  await dispatchToPi(text, atts)
}

/**
 * G6「插话」：steer 注入当前轮（工具跑完后、下次 LLM 调用前生效），
 * 把跑偏的 agent 拽回当前输入。同样落 user 气泡保持对话连续。
 */
async function onSteer() {
  const text = draft.value.trim()
  if (!text || !streaming.value || !cwd.value) return
  const atts: PiAttachment[] = pendingAttachments.value.map((a) => ({
    id: a.id,
    name: a.name,
    kind: a.kind,
    path: a.path,
  }))
  draft.value = ''
  pendingAttachments.value = []
  pushUser(text, atts)
  try {
    await steerTurn(text, atts)
    traceLog('queue:steer', text.slice(0, 40))
  } catch (e) {
    pushSystem(`插话失败：${String(e)}`)
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
    pushSystem(`清空队列失败：${String(e)}`)
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
  // 启动失败不能静默：静默之后用户点发送就是「毫无反应」，且无从排查。
  await start(v).catch((e) => {
    warn(`Pi 内核启动失败：${String(e)}`)
    traceLog('kernel:start-fail', String(e))
  })
  traceLog('kernel:started', v)
  // 内核重启后 thinking level 会回到默认，落一次当前选择保持一致。
  await applyThinking()
  // 首页「先选目录再发送」：目录一就位就把暂存的那句补发出去。
  const pending = pendingHero.value
  pendingHero.value = ''
  if (pending) await dispatchToPi(pending)
})

/** 首页「快速/标准/深度」→ 内核 thinking level。三档语义固定，不做花哨映射。 */
const MODE_LEVEL: Record<string, string> = { 快速: 'low', 标准: 'medium', 深度: 'high' }
const LEVEL_MODE: Record<string, string> = { low: '快速', medium: '标准', high: '深度' }
const thinkingLevel = ref('medium')
/** 反向映射：选完项目进入对话后，头部仍能显示/切换当前档位。 */
const modeLabel = computed(() => LEVEL_MODE[thinkingLevel.value] ?? '标准')

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
  thinkingLevel.value = MODE_LEVEL[mode] ?? 'medium'
  void applyThinking()
}

async function ensureDefaultRole() {
  if (!cwd.value) return
  const cur = await invoke<any | null>('role_current', { root: cwd.value }).catch(() => null)
  if (cur?.id) return
  await invoke('role_set', { id: 'general', root: cwd.value }).catch(() => {})
}

onMounted(async () => {
  // 独立回放窗口：先消费 query 段号（权威目标），再做常规初始化。
  void consumeReplayQuery()
  await ensure()
  await loadActive()
  await ensureDefaultRole()
  stopArtifacts = autoArtifacts(messages, streaming)
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
    warn('本轮还在执行中，等它结束后再打开历史会话。')
    return
  }
  if (loadingHistory.value) return
  loadingHistory.value = true
  try {
    const rep = await loadReplay(undefined, cwd.value || undefined, index)
    if (!rep.messages.length) {
      warn('这条记录没有可重建的消息（可能只剩内核启动标记）。')
      return
    }
    replayDone = true
    messages.value = rep.messages
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
    warn('本轮还在执行中，等它结束后再打开历史会话。')
    return
  }
  loadingHistory.value = true
  try {
    const rep = await loadReplay(undefined, target.cwd || cwd.value || undefined, target.index)
    if (!rep.messages.length) {
      warn('这条记录没有可重建的消息（可能只剩内核启动标记）。')
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
