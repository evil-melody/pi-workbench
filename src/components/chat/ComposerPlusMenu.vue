<script setup lang="ts">
/**
 * Composer「+」菜单（1:1 对齐 WorkBuddy 的召唤形态）。
 *
 * 一个入口收六种能力：添加文件 / 模式 / 专家 / 技能 / 连接器 / 角色。
 * 之前是工具条上一排独立触发器（专家一个、角色一个、附件一个），
 * 用户截图指出「专家触发器和下方 chip 并存 = 同一状态两处展示」——
 * 这里收口成单一来源：菜单负责选择，选中态只以 chip 形式贴在触发器旁。
 *
 * 面板形态：主菜单 + 二级子面板（返回键回退），不做悬停级联 flyout——
 * 子面板复用同一扇定位窗口，flyout 在 28px 高的工具条上定位极易出界。
 *
 * 各行的真实后端（全部已接线，不是装饰）：
 * - 模式：agent/plan/ask 互斥，plan/ask 由 ChatView 拼指令前缀下发；
 * - 专家：experts_list + 真头像，单选，emit 给父级 expertQueue（发送时落策略）；
 * - 技能：skills_list，点击把 `/skill:<name>` 插进草稿（内核斜杠命令通道）；
 * - 连接器：connectors_selection/set_selection/apply_scope（PI_SESSION_ID 作用域）；
 * - 角色：role_list/role_current/role_set（项目级，无目录时禁用）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { invoke } from '@tauri-apps/api/core'
import { t } from '@/i18n'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppCheckbox from '@/components/ui/AppCheckbox.vue'
import { expertsList, loadExpertAvatar, expertAvatars, type ExpertSummary } from '@/composables/useExperts'
import { agentTeamsList, type TeamEntry } from '@/composables/useAgentOps'
import {
  connectorsList,
  connectorsSelection,
  connectorsSetSelection,
  connectorsApplyScope,
  stateText,
  type ConnectorSummary,
} from '@/composables/useConnectors'
import { useRoles } from '@/composables/useRoles'
import { PI_SESSION_ID } from '@/composables/useProject'
import { listOf } from '@/utils/ipc'
import type { SkillEntry } from '@/composables/useSkills'
import type { WorkMode } from '@/utils/workMode'

const props = defineProps<{
  /** 当前工作目录（空 = 没有项目：角色行禁用，连接器作用域照旧）。 */
  cwd: string
  /** 本轮选中的专家（0/1 项，与父级 expertQueue 同一份状态）。 */
  expert: string[]
  /** 本轮绑定的专家团（0/1 项）：发送时由父级转成 team_dispatch 工具指令，不进输入框。 */
  team?: string[]
  /** 工作模式（与思考档 ModeSwitcher 是两回事：一个管先审后做，一个管想多深）。 */
  mode: WorkMode
  /** 添加文件在浏览器模式不可用（附件走 Tauri 对话框）。 */
  canAttach?: boolean
}>()

const emit = defineEmits<{
  attach: []
  insert: [text: string]
  'update:expert': [ids: string[]]
  'update:team': [ids: string[]]
  'update:mode': [mode: WorkMode]
}>()

const router = useRouter()
const rootEl = ref<HTMLElement | null>(null)
const panelEl = ref<HTMLElement | null>(null)
const open = ref(false)
type Panel = 'root' | 'files' | 'mode' | 'expert' | 'skill' | 'connector' | 'role'
const panel = ref<Panel>('root')

// 引用工作区文件：右列列项目根文件，点一下插路径到草稿（对齐 WorkBuddy 双列面板）。
interface FsRow { name: string; path: string; is_dir: boolean }
const files = ref<FsRow[]>([])
const filesLoading = ref(false)
async function loadFiles() {
  if (!props.cwd) { files.value = []; return }
  filesLoading.value = true
  try {
    const list = await invoke<FsRow[]>('fs_read_dir', { path: props.cwd, root: props.cwd })
    files.value = Array.isArray(list) ? list : []
  } catch {
    files.value = []
  } finally {
    filesLoading.value = false
  }
}
function pickFile(f: FsRow) {
  if (f.is_dir) return
  emit('insert', `@${f.path}`)
  close()
}

// ── 专家 ──────────────────────────────────────────────────────
const experts = ref<ExpertSummary[]>([])
const expertsLoading = ref(true)
const expertsFailed = ref(false)
const avatars = expertAvatars()
const expertFilter = ref('')
/** 专家召唤面板的两个真来源：个人专家走 expertId，专家团走 team_dispatch 工具。 */
const summonTab = ref<'expert' | 'team'>('expert')
const teams = ref<TeamEntry[]>([])

const selectedExpertId = computed(() => props.expert[0] ?? '')
const selectedExpert = computed(
  () => experts.value.find((e) => e.id === selectedExpertId.value) ?? null,
)
const selectedAvatar = computed(() =>
  selectedExpertId.value ? avatars.value[selectedExpertId.value] ?? null : null,
)

const selectedTeamId = computed(() => props.team?.[0] ?? '')
const selectedTeam = computed(
  () => teams.value.find((t) => t.id === selectedTeamId.value) ?? null,
)

const visibleExperts = computed(() => {
  const k = expertFilter.value.trim().toLowerCase()
  if (!k) return experts.value
  return experts.value.filter(
    (e) =>
      e.name.toLowerCase().includes(k) ||
      e.id.toLowerCase().includes(k) ||
      e.description.toLowerCase().includes(k) ||
      e.tags.some((tag) => tag.toLowerCase().includes(k)),
  )
})

function avatarOf(e: ExpertSummary): string {
  return (e.name || e.id).trim().charAt(0).toUpperCase()
}

/** 单选：点已选中的项 = 取消（与旧 ExpertPicker 同语义）。草稿不可上场。 */
function pickExpert(e: ExpertSummary) {
  if (!e.published) return
  const id = e.id
  emit('update:expert', id === selectedExpertId.value ? [] : [id])
  close()
}

function clearExpert() {
  emit('update:expert', [])
}

async function loadExperts() {
  expertsLoading.value = true
  expertsFailed.value = false
  try {
    experts.value = (await expertsList()).sort(
      (a, b) => Number(b.published) - Number(a.published) || a.name.localeCompare(b.name),
    )
    const need = experts.value.filter((e) => e.has_avatar && !(e.id in avatars.value))
    for (let i = 0; i < need.length; i += 8) {
      await Promise.all(need.slice(i, i + 8).map((e) => loadExpertAvatar(e.id)))
    }
  } catch {
    experts.value = []
    expertsFailed.value = true
  } finally {
    expertsLoading.value = false
  }
}

function goSummonMore() {
  close()
  void router.push({ path: '/capabilities', query: { tab: 'expert' } })
}

/** 团队召唤：插入内核命令，任务正文由用户在输入框补完；执行走扩展的 team_dispatch。 */
async function loadTeams() {
  try {
    const list = await agentTeamsList()
    teams.value = Array.isArray(list) ? list.filter((x) => !x.deleted) : []
  } catch {
    teams.value = []
  }
}

/** 团队绑定：点选 = 选中并收起菜单，父级发送时转成 team_dispatch 工具指令。
 *  以前是把命令塞进输入框，用户截图看到一串内部 id，
 *  既脏又暴露内部标识——选择态应该和专家一样只以 chip 展示一份。 */
function pickTeam(team: TeamEntry) {
  emit('update:team', team.id === selectedTeamId.value ? [] : [team.id])
  close()
}

function clearTeam() {
  emit('update:team', [])
}

// ── 模式 ──────────────────────────────────────────────────────
const modeRows = computed<{ id: WorkMode; label: string; hint: string }[]>(() => [
  { id: 'agent', label: t('默认（Agent）'), hint: t('直接执行任务') },
  { id: 'plan', label: t('计划（Plan）'), hint: t('先出分步计划，确认后执行') },
  { id: 'ask', label: t('仅问答（Ask）'), hint: t('只回答，不改文件不执行') },
])
const modeLabel = computed(() => modeRows.value.find((m) => m.id === props.mode)?.label ?? '')

function pickMode(m: WorkMode) {
  emit('update:mode', m)
  close()
}

// ── 技能 ──────────────────────────────────────────────────────
const skills = ref<SkillEntry[]>([])
const skillsLoaded = ref(false)

async function loadSkills() {
  if (skillsLoaded.value) return
  try {
    skills.value = await listOf(invoke<SkillEntry[]>('skills_list', { root: null }))
    skillsLoaded.value = true
  } catch {
    skills.value = []
  }
}

/** 点击 = 把斜杠命令插进草稿；发送通道由内核的 /skill 解析，前端不自造第二套。 */
function pickSkill(name: string) {
  emit('insert', `/skill:${name} `)
  close()
}

// ── 连接器 ────────────────────────────────────────────────────
const connectors = ref<ConnectorSummary[]>([])
const connectorSelected = ref<string[]>([])
const connectorsLoaded = ref(false)
const connectorBusy = ref(false)

async function loadConnectors() {
  if (connectorsLoaded.value) return
  try {
    const [list, sel] = await Promise.all([
      listOf(connectorsList()),
      connectorsSelection(PI_SESSION_ID).catch(() => [] as string[]),
    ])
    connectors.value = list
    connectorSelected.value = sel
    connectorsLoaded.value = true
  } catch {
    connectors.value = []
  }
}

/** 选择不是记一下：set_selection 之后必须 apply_scope 才真的改写注入内核的白名单。 */
async function toggleConnector(id: string, on: boolean) {
  if (connectorBusy.value) return
  connectorBusy.value = true
  const next = on
    ? [...connectorSelected.value, id]
    : connectorSelected.value.filter((x) => x !== id)
  try {
    const saved = await connectorsSetSelection(PI_SESSION_ID, next)
    connectorSelected.value = saved
    await connectorsApplyScope(PI_SESSION_ID).catch(() => {})
  } catch {
    // 后端拒绝（已停用/未握手/超上限）：回读一次真实选择，不假装成功。
    connectorSelected.value = await connectorsSelection(PI_SESSION_ID).catch(() => next)
  } finally {
    connectorBusy.value = false
  }
}

// ── 角色 ──────────────────────────────────────────────────────
const { roles, currentId: roleId, load: loadRoles, current: currentRole, set: setRole } =
  useRoles(() => props.cwd)
const rolesLoaded = ref(false)

async function ensureRoles() {
  if (!props.cwd) return
  if (!rolesLoaded.value) {
    await loadRoles().catch(() => {})
    rolesLoaded.value = true
  }
  await currentRole().catch(() => {})
}

async function pickRole(id: string) {
  await setRole(id).catch(() => {})
  close()
}

/** 主列「角色」行的当前值：与模式/专家同语义，选了就要回显，不能光秃秃。
 *  role_current 只给 id，名字从已加载的 roles 里解析；未加载时回落到 id。 */
const roleLabel = computed(() => {
  if (!props.cwd || !roleId.value) return ''
  return roles.value.find((r) => r.id === roleId.value)?.name ?? roleId.value
})

// ── 打开/加载编排：懒加载子面板数据，挂载先拉专家（chip 名字要能解析）──
async function openPanel(next: Panel) {
  panel.value = next
  if (next === 'files') await loadFiles().then(reposition)
  else if (next === 'expert') await Promise.all([loadExperts(), loadTeams()]).then(reposition)
  else if (next === 'skill') await loadSkills().then(reposition)
  else if (next === 'connector') await loadConnectors().then(reposition)
  else if (next === 'role') await ensureRoles().then(reposition)
  else reposition()
}

function back() {
  panel.value = 'root'
  reposition()
}

/** drill-in（窄屏回落）时返回头显示的子面板名。 */
const flyTitle = computed(() => {
  switch (panel.value) {
    case 'files':
      return t('引用对话中的文件')
    case 'mode':
      return t('模式')
    case 'expert':
      return t('专家')
    case 'skill':
      return t('技能')
    case 'connector':
      return t('连接器')
    case 'role':
      return t('角色')
    default:
      return ''
  }
})

function close() {
  open.value = false
  summonTab.value = 'expert'
}

async function toggle() {
  if (open.value) {
    close()
    return
  }
  panel.value = 'root'
  open.value = true
  reposition()
  await nextTick()
  reposition()
}

function onRow(kind: Panel | 'attach') {
  if (kind === 'attach') {
    emit('attach')
    close()
    return
  }
  void openPanel(kind)
}

// ── 定位：fixed + 视口夹取 + 空间不足向上翻（与工具栏菜单同一套规则）──
const MENU_GAP = 6
const VIEW_PAD = 8
// 1:1 WorkBuddy：主列 320 / 行高 46。flyout 子列并排弹出（用户截图
// 「专家团点进去整屏替换、还带返回键」不对——WorkBuddy 是两列并列）。
// 视口放不下两列时（< FLYOUT_MIN_VW）回落为 drill-in：子列独占、带返回头。
const MENU_W = 320
const FLY_W = 300
const FLY_GAP = 6
const FLYOUT_MIN_VW = MENU_W + FLY_W + FLY_GAP + VIEW_PAD * 2 + 120
const MENU_MAX_H = 520
const menuStyle = ref<Record<string, string>>({})
const flyoutMode = ref(true)

function reposition() {
  const el = rootEl.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  flyoutMode.value = vw >= FLYOUT_MIN_VW
  const showFly = panel.value !== 'root'
  const w = Math.min(
    MENU_W + (showFly && flyoutMode.value ? FLY_GAP + FLY_W : 0),
    vw - VIEW_PAD * 2,
  )
  const maxH = Math.min(MENU_MAX_H, vh - VIEW_PAD * 2)
  const h = Math.min(panelEl.value?.offsetHeight || maxH, maxH)
  const below = vh - r.bottom - MENU_GAP - VIEW_PAD
  const above = r.top - MENU_GAP - VIEW_PAD
  const up = below < h && above > below
  const top = up
    ? Math.max(VIEW_PAD, r.top - MENU_GAP - h)
    : Math.min(r.bottom + MENU_GAP, Math.max(VIEW_PAD, vh - VIEW_PAD - h))
  const left = Math.min(Math.max(VIEW_PAD, r.left), Math.max(VIEW_PAD, vw - w - VIEW_PAD))
  menuStyle.value = {
    top: `${Math.round(top)}px`,
    left: `${Math.round(left)}px`,
    width: `${Math.round(w)}px`,
    maxHeight: `${Math.round(maxH)}px`,
  }
}

function onDocClick(e: MouseEvent) {
  if (!open.value) return
  const target = e.target as Node
  if (rootEl.value?.contains(target)) return
  if (panelEl.value?.contains(target)) return
  close()
}

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (panel.value !== 'root') {
    back()
    return
  }
  close()
}

watch(open, (v) => {
  if (v) {
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
  } else {
    window.removeEventListener('scroll', reposition, true)
    window.removeEventListener('resize', reposition)
  }
})

// 绑定工作目录后即预取角色（与专家同等待遇）：主列「角色」行的当前值
// 不依赖用户先展开子面板才能解析名字。
watch(
  () => props.cwd,
  (v) => {
    if (v) void ensureRoles()
  },
  { immediate: true },
)

onMounted(() => {
  document.addEventListener('click', onDocClick, true)
  document.addEventListener('keydown', onKey)
  // 专家清单挂载即拉一次：chip 显示名字/头像不依赖用户先开菜单。
  void loadExperts()
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick, true)
  document.removeEventListener('keydown', onKey)
  window.removeEventListener('scroll', reposition, true)
  window.removeEventListener('resize', reposition)
})

defineExpose({ reload: loadExperts })
</script>

<template>
  <div ref="rootEl" class="cpm">
    <AppButton
      type="button"
      variant="icon"
      class="cpm-trigger"
      :title="t('添加文件与能力：模式 / 专家 / 技能 / 连接器 / 角色')"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click.stop="toggle"
    >
      <AppIcon name="plus" :size="16" />
    </AppButton>

    <!-- 选中态只在这里出现一份：菜单负责选择，chip 负责展示（可移除）。 -->
    <span v-if="selectedExpert" class="cpm-chip" :title="selectedExpert?.description || selectedExpertId">
      <img v-if="selectedAvatar" class="cpm-chip-avatar" :src="selectedAvatar" alt="" />
      <span v-else class="cpm-chip-avatar cpm-chip-initial">{{ avatarOf(selectedExpert!) }}</span>
      <span class="cpm-chip-name">{{ selectedExpert?.name ?? selectedExpertId }}</span>
      <button
        type="button"
        class="cpm-chip-x"
        :title="t('移除专家')"
        :aria-label="t('移除专家')"
        @click.stop="clearExpert"
      >
        <AppIcon name="close" :size="10" />
      </button>
    </span>
    <span v-if="mode !== 'agent'" class="cpm-chip mode" :title="t('工作模式')">
      <AppIcon name="mouse-pointer" :size="11" />
      <span class="cpm-chip-name">{{ modeLabel }}</span>
    </span>
    <!-- 团队绑定 chip：与专家同一形态（选择态只此一处），发送时父级转成 team_dispatch 工具指令。
         以前把命令塞进输入框，用户看见一串内部 id。 -->
    <span v-if="selectedTeam" class="cpm-chip team" :title="selectedTeam.id">
      <AppIcon name="users" :size="12" />
      <span class="cpm-chip-name">{{ selectedTeam.name || selectedTeam.id }}</span>
      <button
        type="button"
        class="cpm-chip-x"
        :title="t('移除专家团')"
        :aria-label="t('移除专家团')"
        @click.stop="clearTeam"
      >
        <AppIcon name="close" :size="10" />
      </button>
    </span>

    <Teleport to="body">
      <div
        v-if="open"
        ref="panelEl"
        class="cpm-menu"
        :class="{ 'is-drill': !flyoutMode && panel !== 'root' }"
        :style="menuStyle"
        role="menu"
        @click.stop
      >
        <!-- 主列：flyout 形态下常驻（WorkBuddy 1:1——点子行不替换整屏，子面板在右侧并列弹出）。
             窄屏回落 drill-in：主列隐藏、子列独占，此时子列才需要返回头。 -->
        <div class="cpm-col cpm-col-main">
          <button
            type="button"
            class="cpm-row primary"
            role="menuitem"
            :disabled="!canAttach"
            :title="canAttach ? t('附带图片或文件') : t('附件需在桌面 App 中使用')"
            @click="onRow('attach')"
          >
            <AppIcon name="paperclip" :size="18" />
            <span class="cpm-row-label">{{ t('添加文件') }}</span>
          </button>

          <button
            type="button"
            class="cpm-row"
            role="menuitem"
            :class="{ on: panel === 'files' }"
            :disabled="!props.cwd"
            @click="onRow('files')"
          >
            <AppIcon name="folder" :size="18" />
            <span class="cpm-row-label">{{ t('引用对话中的文件') }}</span>
            <span class="cpm-row-value">{{ t('工作区') }}</span>
            <AppIcon name="chevron-right" :size="14" class="cpm-row-arrow" />
          </button>

          <button
            type="button"
            class="cpm-row"
            role="menuitem"
            :class="{ on: panel === 'mode' }"
            @click="onRow('mode')"
          >
            <AppIcon name="sliders" :size="18" />
            <span class="cpm-row-label">{{ t('模式') }}</span>
            <span class="cpm-row-value">{{ modeLabel }}</span>
            <AppIcon name="chevron-right" :size="14" class="cpm-row-arrow" />
          </button>

          <button
            type="button"
            class="cpm-row"
            role="menuitem"
            :class="{ on: panel === 'expert' }"
            @click="onRow('expert')"
          >
            <AppIcon name="puzzle" :size="18" />
            <span class="cpm-row-label">{{ t('专家') }}</span>
            <span v-if="selectedExpert" class="cpm-row-value">{{ selectedExpert.name }}</span>
            <AppIcon name="chevron-right" :size="14" class="cpm-row-arrow" />
          </button>

          <button
            type="button"
            class="cpm-row"
            role="menuitem"
            :class="{ on: panel === 'skill' }"
            @click="onRow('skill')"
          >
            <AppIcon name="zap" :size="18" />
            <span class="cpm-row-label">{{ t('技能') }}</span>
            <AppIcon name="chevron-right" :size="14" class="cpm-row-arrow" />
          </button>

          <button
            type="button"
            class="cpm-row"
            role="menuitem"
            :class="{ on: panel === 'connector' }"
            @click="onRow('connector')"
          >
            <AppIcon name="plug" :size="18" />
            <span class="cpm-row-label">{{ t('连接器') }}</span>
            <span v-if="connectorSelected.length" class="cpm-row-value">{{ t('{0} 已选', [connectorSelected.length]) }}</span>
            <AppIcon name="chevron-right" :size="14" class="cpm-row-arrow" />
          </button>

          <button
            type="button"
            class="cpm-row"
            role="menuitem"
            :class="{ on: panel === 'role' }"
            :disabled="!cwd"
            :title="cwd ? '' : t('角色是项目级配置：先选工作目录')"
            @click="onRow('role')"
          >
            <AppIcon name="user" :size="18" />
            <span class="cpm-row-label">{{ t('角色') }}</span>
            <span v-if="roleLabel" class="cpm-row-value">{{ roleLabel }}</span>
            <AppIcon name="chevron-right" :size="14" class="cpm-row-arrow" />
          </button>
        </div>

        <!-- 子列：flyout 与主列并列；drill-in（窄屏）独占整卡并带返回头 -->
        <div v-if="panel !== 'root'" class="cpm-col cpm-col-fly">
          <div v-if="!flyoutMode" class="cpm-sub-head">
            <button type="button" class="cpm-back" :aria-label="t('返回')" @click="back">
              <AppIcon name="chevron-left" :size="14" />
            </button>
            <span class="cpm-sub-title">{{ flyTitle }}</span>
          </div>

          <!-- 引用工作区文件：与专家/技能同形态的列表，点文件插 @路径 -->
          <template v-if="panel === 'files'">
            <p v-if="filesLoading" class="cpm-empty">{{ t('正在读取文件…') }}</p>
            <template v-else-if="!files.length">
              <p class="cpm-empty">{{ t('工作区没有可引用的文件。') }}</p>
            </template>
            <div v-else class="cpm-list">
              <button
                v-for="f in files"
                :key="f.path"
                type="button"
                class="cpm-row cpm-file"
                :disabled="f.is_dir"
                :title="f.path"
                @click="pickFile(f)"
              >
                <AppIcon :name="f.is_dir ? 'folder' : 'file'" :size="16" />
                <span class="cpm-row-label">{{ f.name }}</span>
                <AppIcon v-if="!f.is_dir" name="plus" :size="14" class="cpm-row-arrow" />
              </button>
            </div>
          </template>

          <!-- 模式 -->
          <template v-else-if="panel === 'mode'">
            <button
              v-for="m in modeRows"
              :key="m.id"
              type="button"
              class="cpm-row"
              :class="{ on: mode === m.id }"
              role="menuitemradio"
              :aria-checked="mode === m.id"
              @click="pickMode(m.id)"
            >
              <span class="cpm-row-main">
                <span class="cpm-row-label">{{ m.label }}</span>
                <span class="cpm-row-hint">{{ m.hint }}</span>
              </span>
              <AppIcon v-if="mode === m.id" name="check" :size="14" class="cpm-tick" />
            </button>
          </template>

        <!-- 专家 / 专家团（同一召唤入口的两个真来源；返回头在 fly 列统一渲染） -->
        <template v-else-if="panel === 'expert'">
          <div class="cpm-tabs" role="tablist">
            <button
              type="button"
              class="cpm-tab"
              :class="{ on: summonTab === 'expert' }"
              role="tab"
              :aria-selected="summonTab === 'expert'"
              @click="summonTab = 'expert'; reposition()"
            >
              {{ t('专家') }}
            </button>
            <button
              type="button"
              class="cpm-tab"
              :class="{ on: summonTab === 'team' }"
              role="tab"
              :aria-selected="summonTab === 'team'"
              @click="summonTab = 'team'; reposition()"
            >
              {{ t('专家团') }}
            </button>
          </div>
          <template v-if="summonTab === 'expert'">
            <AppInput
              v-model="expertFilter"
              class="cpm-search"
              :placeholder="t('搜索专家')"
              @keydown.stop
            />
            <p v-if="expertsLoading" class="cpm-empty">{{ t('正在读取专家…') }}</p>
            <template v-else-if="expertsFailed">
              <p class="cpm-empty">{{ t('专家清单读取失败（内核没有响应）。') }}</p>
              <div class="cpm-actions">
                <AppButton variant="secondary" @click="loadExperts">{{ t('重试') }}</AppButton>
              </div>
            </template>
            <template v-else-if="!experts.length">
              <p class="cpm-empty">{{ t('还没有专家。去能力中心创建或导入。') }}</p>
            </template>
            <div v-else class="cpm-list">
              <p v-if="!visibleExperts.length" class="cpm-empty">{{ t('没有匹配的专家') }}</p>
              <button
                v-for="e in visibleExperts"
                :key="e.id"
                type="button"
                class="cpm-expert"
                :class="{ on: e.id === selectedExpertId, draft: !e.published }"
                role="menuitemradio"
                :aria-checked="e.id === selectedExpertId"
                :aria-disabled="!e.published"
                :title="e.published ? '' : t('草稿未发布，不能参与对话。去能力中心发布后再召唤。')"
                @click="pickExpert(e)"
              >
                <span class="cpm-expert-avatar" aria-hidden="true">
                  <img v-if="avatars[e.id]" :src="avatars[e.id]!" alt="" />
                  <template v-else>{{ avatarOf(e) }}</template>
                </span>
                <span class="cpm-expert-main">
                  <span class="cpm-expert-name">
                    {{ e.name || e.id }}
                    <em v-if="e.published" class="cpm-live">{{ t('已发布') }}</em>
                    <em v-else class="cpm-draft">{{ t('草稿') }}</em>
                  </span>
                  <span class="cpm-expert-desc">{{ e.description || e.role || e.id }}</span>
                </span>
                <AppIcon v-if="e.id === selectedExpertId" name="check" :size="14" class="cpm-tick" />
              </button>
            </div>
            <div class="cpm-foot">
              <button type="button" class="cpm-more" @click="goSummonMore">
                <AppIcon name="users" :size="12" />
                <span>{{ t('召唤更多专家') }}</span>
                <AppIcon name="chevron-right" :size="11" />
              </button>
            </div>
          </template>
          <template v-else>
            <p v-if="!teams.length" class="cpm-empty">{{ t('还没有团队') }}</p>
            <div v-else class="cpm-list">
              <button
                v-for="team in teams"
                :key="team.id"
                type="button"
                class="cpm-expert"
                :class="{ on: team.id === selectedTeamId }"
                role="menuitemradio"
                :aria-checked="team.id === selectedTeamId"
                :title="t('调度')"
                @click="pickTeam(team)"
              >
                <span class="cpm-expert-avatar" aria-hidden="true">
                  <AppIcon name="users" :size="16" />
                </span>
                <span class="cpm-expert-main">
                  <span class="cpm-expert-name">{{ team.name || team.id }}</span>
                  <span class="cpm-expert-desc">
                    {{ t('{0} 名成员', [team.members.length]) }} · {{ team.strategy || 'sequential' }}
                  </span>
                </span>
                <!-- 团队是单选绑定（chip 回显），与专家同语义：勾，不是「填入输入框」的回车键。 -->
                <AppIcon v-if="team.id === selectedTeamId" name="check" :size="14" class="cpm-tick" />
              </button>
            </div>
          </template>
        </template>

        <!-- 技能 -->
        <template v-else-if="panel === 'skill'">
          <p v-if="!skills.length" class="cpm-empty">{{ t('没有可用技能。去能力中心安装。') }}</p>
          <div v-else class="cpm-list">
            <button
              v-for="s in skills"
              :key="s.name"
              type="button"
              class="cpm-row"
              role="menuitem"
              @click="pickSkill(s.name)"
            >
              <AppIcon name="puzzle" :size="13" />
              <span class="cpm-row-main">
                <span class="cpm-row-label">{{ s.name }}</span>
                <span v-if="s.description" class="cpm-row-hint">{{ s.description }}</span>
              </span>
            </button>
          </div>
        </template>

        <!-- 连接器 -->
        <template v-else-if="panel === 'connector'">
          <p v-if="!connectors.length" class="cpm-empty">{{ t('还没有连接器。去能力中心创建或导入。') }}</p>
          <div v-else class="cpm-list">
            <div
              v-for="c in connectors"
              :key="c.id"
              class="cpm-conn"
              :class="{ off: !c.enabled || c.state !== 'ready' }"
            >
              <AppCheckbox
                :model-value="connectorSelected.includes(c.id)"
                :disabled="!c.enabled || c.state !== 'ready' || connectorBusy"
                :label="c.title || c.server_name"
                @update:model-value="(v: boolean) => toggleConnector(c.id, v)"
              />
              <span class="cpm-conn-state">{{ stateText(c.state) }}</span>
            </div>
          </div>
        </template>

        <!-- 角色 -->
        <template v-else-if="panel === 'role'">
          <p v-if="!roles.length" class="cpm-empty">{{ t('这个项目还没有可用角色。') }}</p>
          <div v-else class="cpm-list">
            <button
              v-for="r in roles"
              :key="r.id"
              type="button"
              class="cpm-row"
              :class="{ on: r.id === roleId }"
              role="menuitemradio"
              :aria-checked="r.id === roleId"
              @click="pickRole(r.id)"
            >
              <span class="cpm-row-main">
                <span class="cpm-row-label">{{ r.name }}</span>
                <span v-if="r.description" class="cpm-row-hint">{{ r.description }}</span>
              </span>
              <AppIcon v-if="r.id === roleId" name="check" :size="14" class="cpm-tick" />
            </button>
          </div>
        </template>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style src="./ComposerPlusMenu.css" scoped></style>
