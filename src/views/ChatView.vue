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

          <!-- 会话迁移：导出当前对话为 JSON / 导入历史会话。与 DSH 的 dsh-chat-import 对齐。 -->
          <div class="io-group" role="group" aria-label="会话迁移">
            <button class="io-btn" title="导出当前会话为 JSON 文件" @click="onExport">
              <AppIcon name="download" :size="13" />
              <span>导出</span>
            </button>
            <button class="io-btn" title="从 JSON 文件导入会话" @click="onImport">
              <AppIcon name="upload" :size="13" />
              <span>导入</span>
            </button>
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

        <form class="composer" @submit.prevent="submit">
          <ComposerStatus
            :state="activity"
            :running="streaming"
            :usage="usage.last"
            :project-id="activeProjectId"
            @interrupt="abort"
          />
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
          <div class="input-wrap">
            <button
              type="button"
              class="attach"
              :title="IN_TAURI ? '附带图片或文件' : '附件需在桌面 App 中使用'"
              :disabled="!IN_TAURI"
              @click="onAttach"
            >
              <AppIcon name="paperclip" :size="16" />
            </button>
            <AppTextarea
              v-model="draft"
              placeholder="给 Pi 下达编码任务…（可附带图片或文件）"
              :rows="1"
              @keydown.enter="onEnter"
            />
            <button
              type="submit"
              class="send"
              :disabled="streaming || (!draft.trim() && pendingAttachments.length === 0) || !cwd"
            >
              <AppIcon name="send" :size="16" />
            </button>
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
import MessageList from '@/components/chat/MessageList.vue'
import ComposerStatus from '@/components/chat/ComposerStatus.vue'
import ChatHero from '@/components/chat/ChatHero.vue'
import ModeSwitcher from '@/components/chat/ModeSwitcher.vue'
import ModelSwitcher from '@/components/chat/ModelSwitcher.vue'
import WorkspacePicker from '@/components/chat/WorkspacePicker.vue'
import TraceDrawer from '@/components/chat/TraceDrawer.vue'
import RoleSwitcher from '@/components/layout/RoleSwitcher.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppTextarea from '@/components/ui/AppTextarea.vue'
import { IN_TAURI, usePi, type PiAttachment } from '@/composables/usePi'
import { fmtCost, fmtTokens } from '@/composables/piEvents'
import { useArtifacts } from '@/composables/useArtifacts'
import { useActivity } from '@/composables/useActivity'
import { PI_EVENTS, usePiEvents } from '@/composables/usePiEvents'
import { shouldShowHero } from '@/composables/chatStage'
import { traceLog } from '@/composables/useWebLog'
import { pickDirectoryGuarded, PICK_TIMEOUT_NOTE } from '@/composables/useDirPicker'
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

const { messages, streaming, usage, ensure, start, stop, send, pushUser, pushSystem, rpc } = usePi()

const cwd = ref('')
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

/** 中断本轮：先置相位，再下发 pi_stop，等内核回 process_exit 后交还自动投影。 */
async function abort() {
  interrupt()
  await stop().catch(() => {})
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

/** 下发到内核：项目上下文前缀 + 用户原文 + 附件引用块。 */
async function dispatchToPi(text: string, attachments?: PiAttachment[]) {
  traceLog('dispatch', text.slice(0, 50))
  const preamble = await taskContextPreamble().catch(() => '')
  pushUser(text, attachments)
  const body = preamble ? `${preamble}\n\n---\n\n${text}` : text
  try {
    await send(body, attachments)
    traceLog('dispatch:sent')
  } catch (e) {
    // 失败必须落进消息流：只在顶部飘一条 6 秒 notice，用户看到的就是「点了没反应」。
    pushSystem(`内核未响应：${String(e)}`)
    warn(String(e))
    traceLog('dispatch:fail', String(e))
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
  await dispatchToPi(text, atts)
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
  await ensure()
  await loadActive()
  await ensureDefaultRole()
  stopArtifacts = autoArtifacts(messages, streaming)
})

onUnmounted(() => {
  stopArtifacts?.()
  stopArtifacts = null
})
</script>

<style src="./ChatView.css" scoped></style>
