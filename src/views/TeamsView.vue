<script setup lang="ts">
import { t } from '@/i18n'
/**
 * 多智能体团队（团队编排运行态）。
 *
 * 读取 Rust 后端 `agent_teams_list`；新建走 `agent_team_create`（脱离 Pi 也能建，
 * 建出的团队定义会被 Pi 工具 `team_create`/`team_dispatch` 读取，形成人面 + agent 面闭环）。
 *
 * 成员键带前缀：`e:<expertId>` 才能让调度端读到专家人格并沿用该专家的工具门；
 * 技能 / 连接器只是标签。旧团队存纯标签时按普通成员展示。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import RuntimeNote from '@/components/runtime/RuntimeNote.vue'
import { describeIpcError } from '@/composables/useRuntime'
import { expertsList, type ExpertSummary } from '@/composables/useExperts'
import { connectorsList, type ConnectorSummary } from '@/composables/useConnectors'
import {
  agentTeamsList,
  agentTeamCreate,
  agentTeamUpdate,
  agentTeamDelete,
  agentTeamCancelRun,
  agentTeamRuns,
  type TeamEntry,
  type TeamRunEvent,
} from '@/composables/useAgentOps'
import { listOf } from '@/utils/ipc'

interface SkillEntry {
  name: string
  description: string
}
interface Candidate {
  key: string
  label: string
  kind: string
  icon: string
}

defineProps<{ embedded?: boolean }>()

const teams = ref<TeamEntry[]>([])
const busy = ref(false)
const status = ref('')
const statusError = ref(false)
const dialog = ref(false)
/** create 新建 / edit 编辑：同一套表单，校验与写入口不同。 */
const dialogMode = ref<'create' | 'edit'>('create')
const editingId = ref<string | null>(null)

const candidates = ref<Candidate[]>([])
const candLoading = ref(false)
const selected = ref<string[]>([])
const formCustom = ref('')
const formName = ref('')
const formStrategy = ref('sequential')
const formLead = ref('')
const formOnFailure = ref('stop')

const strategyOptions = computed(() => [
  { value: 'sequential', label: t('顺序 sequential') },
  { value: 'parallel', label: t('并行 parallel') },
  { value: 'debate', label: t('辩论 debate') },
])
const failureOptions = computed(() => [
  { value: 'stop', label: t('停止后续交接') },
  { value: 'continue', label: t('继续跑其余成员') },
  { value: 'retry', label: t('重试一次再停止') },
])

const strategyText = (s: string | null) =>
  ({ sequential: t('顺序'), parallel: t('并行'), debate: t('辩论') })[s ?? 'sequential'] ?? s ?? t('顺序')
const failureText = (s: string | null) =>
  ({ stop: t('失败即停'), continue: t('失败继续'), retry: t('失败重试') })[s ?? 'stop'] ?? s ?? t('失败即停')

/** 成员键 → 显示名：候选里查得到就用候选名，否则去掉前缀。 */
function labelOf(key: string | null | undefined): string {
  if (!key) return '—'
  const hit = candidates.value.find((c) => c.key === key)
  if (hit) return hit.label
  return key.replace(/^[esc]:/, '')
}

/** 成员引用的专家是否已不存在（候选清单只含现存专家）。清单未加载完时不下结论。 */
function isDangling(key: string): boolean {
  if (!key.startsWith('e:') || !candidates.value.length) return false
  return !candidates.value.some((c) => c.key === key)
}

const customMembers = computed(() =>
  formCustom.value
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean),
)
const memberKeys = computed(() => Array.from(new Set([...selected.value, ...customMembers.value])))
const leadOptions = computed(() =>
  memberKeys.value.map((key) => ({ value: key, label: labelOf(key) })),
)

// 成员变化后牵头人失效就清空，避免提交一个不在团队里的牵头人。
watch(memberKeys, (keys) => {
  if (formLead.value && !keys.includes(formLead.value)) formLead.value = ''
})

async function refresh() {
  busy.value = true
  status.value = ''
  statusError.value = false
  try {
    teams.value = await agentTeamsList()
  } catch (e) {
    status.value = describeIpcError(e, t('加载团队'))
    statusError.value = true
  }
  busy.value = false
}

async function loadCandidates() {
  candLoading.value = true
  try {
    const [exps, skills, cons] = await Promise.all([
      expertsList().catch(() => [] as ExpertSummary[]),
      listOf(invoke<SkillEntry[]>('skills_list', { root: null })),
      connectorsList().catch(() => [] as ConnectorSummary[]),
    ])
    const list: Candidate[] = []
    for (const e of exps) list.push({ key: `e:${e.id}`, label: e.name || e.id, kind: t('专家'), icon: 'sparkles' })
    for (const s of skills) list.push({ key: `s:${s.name}`, label: s.name, kind: t('技能'), icon: 'puzzle' })
    for (const c of cons) list.push({ key: `c:${c.id}`, label: c.title || c.server_name, kind: t('连接器'), icon: 'plug' })
    candidates.value = list
  } catch {
    candidates.value = []
  }
  candLoading.value = false
}

function openDialog() {
  if (!candidates.value.length) void loadCandidates()
  dialogMode.value = 'create'
  editingId.value = null
  selected.value = []
  formCustom.value = ''
  formName.value = ''
  formStrategy.value = 'sequential'
  formLead.value = ''
  formOnFailure.value = 'stop'
  status.value = ''
  statusError.value = false
  dialog.value = true
}

/** 编辑：把现有定义回填到同一套表单，候选清单未加载完也不丢成员。 */
function openEdit(team: TeamEntry) {
  if (!candidates.value.length) void loadCandidates()
  dialogMode.value = 'edit'
  editingId.value = team.id
  const prefixed = team.members.filter((m) => /^[esc]:/.test(m))
  const plain = team.members.filter((m) => !/^[esc]:/.test(m))
  selected.value = [...prefixed]
  formCustom.value = plain.join(', ')
  formName.value = team.name
  formStrategy.value = team.strategy ?? 'sequential'
  formLead.value = team.lead ?? team.members[0] ?? ''
  formOnFailure.value = team.on_failure ?? 'stop'
  status.value = ''
  statusError.value = false
  dialog.value = true
}

function toggle(key: string) {
  const i = selected.value.indexOf(key)
  if (i >= 0) selected.value.splice(i, 1)
  else selected.value.push(key)
}

const memberCount = computed(() =>
  teams.value.filter((x) => !x.deleted).reduce((n, x) => n + (x.members?.length ?? 0), 0),
)
const activeTeams = computed(() => teams.value.filter((x) => !x.deleted))
const deletedTeams = computed(() => teams.value.filter((x) => x.deleted))

async function submit() {
  const name = formName.value.trim()
  if (!name) {
    status.value = t('请填写团队名')
    return
  }
  // 成员不重复：手动补充项自身重复，或与已选成员撞车，都要明确拦下。
  const rawCustom = formCustom.value
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
  const dup = rawCustom.find((v, i) => rawCustom.indexOf(v) !== i)
  if (dup) {
    status.value = t('成员重复：{0}', [dup])
    return
  }
  const clash = rawCustom.find((v) => selected.value.includes(v))
  if (clash) {
    status.value = t('成员重复：{0}', [clash])
    return
  }
  const members = memberKeys.value
  if (!members.length) {
    status.value = t('请至少选择 / 填写一名成员')
    return
  }
  const lead = formLead.value || members[0]
  if (!members.includes(lead)) {
    status.value = t('牵头人必须是团队成员')
    return
  }
  try {
    let saved: TeamEntry
    const editId = dialogMode.value === 'edit' && editingId.value ? editingId.value : null
    if (editId) {
      saved = await agentTeamUpdate(
        editId,
        name,
        members,
        formStrategy.value,
        lead,
        formOnFailure.value,
      )
    } else {
      saved = await agentTeamCreate(name, members, formStrategy.value, lead, formOnFailure.value)
    }
    dialog.value = false
    await refresh()
    // refresh() 会清空 status，成功文案必须放在它之后，否则保存成功却看不到反馈。
    status.value = editId
      ? t('已保存团队「{0}」；正在运行的实例继续按旧定义跑完', [saved.name])
      : t('已创建团队「{0}」', [saved.name])
    statusError.value = false
  } catch (e) {
    status.value = describeIpcError(e, t('保存团队'))
    statusError.value = true
  }
}

// ── 删除：软删除定义，历史运行记录保留；正在运行先提示并允许先取消 ──

const deleteTarget = ref<TeamEntry | null>(null)
const deleteBusy = ref(false)
const deleteNotice = ref('')

function requestDelete(team: TeamEntry) {
  deleteTarget.value = team
  deleteNotice.value = ''
  deleteBusy.value = false
}

async function cancelActiveForDelete() {
  const team = deleteTarget.value
  if (!team?.active_run_id) return
  try {
    await agentTeamCancelRun(team.id, team.active_run_id)
    deleteNotice.value = t('已请求取消运行，成员子进程会在数秒内停止；随后可删除。')
  } catch (e) {
    deleteNotice.value = describeIpcError(e, t('取消团队运行'))
  }
}

async function confirmDelete() {
  const team = deleteTarget.value
  if (!team) return
  deleteBusy.value = true
  try {
    await agentTeamDelete(team.id)
    deleteTarget.value = null
    await refresh()
    status.value = t('已删除团队「{0}」，历史运行记录保留可查', [team.name])
    statusError.value = false
  } catch (e) {
    deleteNotice.value = describeIpcError(e, t('删除团队'))
  }
  deleteBusy.value = false
}

// ── 运行记录：真实调度日志（team_dispatch 写入），打开时轮询显示成员进度 ──

interface RunRow {
  label: string
  ok: boolean | null
  duration: string
  note: string
  output: string
  lead: boolean
  /** 该行是被取消的成员：显示「已取消」，不计失败。 */
  cancelled?: boolean
  /** 事件时间：运行记录按它重排，交接才不会沉底。 */
  at?: number
}

const runsOpen = ref(false)
const runsTeam = ref<TeamEntry | null>(null)
const runsEvents = ref<TeamRunEvent[]>([])
const runsLoading = ref(false)
/** 运行记录弹窗内的操作反馈（取消请求等），不动工具栏状态。 */
const runsNotice = ref('')
const cancelling = ref('')
let runsTimer: number | undefined

async function loadRuns() {
  if (!runsTeam.value) return
  runsLoading.value = true
  try {
    runsEvents.value = await agentTeamRuns(runsTeam.value.id)
  } catch {
    runsEvents.value = []
  }
  runsLoading.value = false
}

function openRuns(team: TeamEntry) {
  runsTeam.value = team
  runsOpen.value = true
  runsEvents.value = []
  runsNotice.value = ''
  void loadRuns()
  window.clearInterval(runsTimer)
  // 成员是独立子进程：轮询是最省事的「实时」方案，关闭弹窗即停。
  runsTimer = window.setInterval(loadRuns, 2500)
}

/** 取消一次运行：后端落标记文件，Extension 轮询后 kill 成员子进程。 */
async function cancelRun(runId: string) {
  if (!runsTeam.value) return
  cancelling.value = runId
  runsNotice.value = ''
  try {
    await agentTeamCancelRun(runsTeam.value.id, runId)
    runsNotice.value = t('已请求取消，成员子进程会在数秒内停止；已产出内容会保留在记录里。')
    await loadRuns()
  } catch (e) {
    runsNotice.value = describeIpcError(e, t('取消团队运行'))
  }
  cancelling.value = ''
}

function closeRuns() {
  runsOpen.value = false
  window.clearInterval(runsTimer)
  runsTimer = undefined
}

onBeforeUnmount(() => window.clearInterval(runsTimer))

const runsGrouped = computed(() => {
  const map = new Map<string, TeamRunEvent[]>()
  for (const e of runsEvents.value) {
    const id = e.run_id ?? '—'
    if (!map.has(id)) map.set(id, [])
    map.get(id)!.push(e)
  }
  return Array.from(map.entries())
    .reverse()
    .map(([runId, events]) => {
      const rows: RunRow[] = []
      const cancelled = events.some((e) => e.cancelled)
      const ends = events.filter((e) => e.type === 'member_end' || (!e.type && e.member))
      for (const e of ends) {
        const retries = events.filter(
          (x) =>
            x.type === 'member_retry' &&
            x.member === e.member &&
            (x.round ?? 0) === (e.round ?? 0),
        ).length
        const facts: string[] = []
        if (e.round) facts.push(t('第 {0} 轮', [e.round]))
        if (retries) facts.push(t('重试 {0} 次', [retries]))
        if (e.cancelled) facts.push(t('已取消'))
        rows.push({
          label: e.label ?? labelOf(e.member),
          ok: e.ok ?? false,
          duration: e.duration_ms != null ? `${(e.duration_ms / 1000).toFixed(1)}s` : '',
          note: facts.join(' · '),
          output: e.output ?? '',
          lead: !!e.lead,
          cancelled: !!e.cancelled,
          at: e.at,
        })
      }
      // 已开始没结束的成员 = 正在进行。
      const running = events.filter(
        (e) =>
          e.type === 'member_start' &&
          !ends.some((x) => x.member === e.member && (x.at ?? 0) >= (e.at ?? 0)),
      )
      for (const e of running) {
        rows.push({
          label: e.label ?? labelOf(e.member),
          ok: null,
          duration: '',
          note: t('进行中'),
          output: '',
          lead: !!e.lead,
          at: e.at,
        })
      }
      for (const e of events.filter((x) => x.type === 'handoff')) {
        rows.push({
          label: `${labelOf(e.from)} → ${labelOf(e.to)}`,
          ok: true,
          duration: '',
          note: t('交接'),
          output: '',
          lead: false,
          at: e.at,
        })
      }
      // 取消也是一次有意的收口，不再额外显示一条红色「中断」。
      const aborted = cancelled ? undefined : events.find((e) => e.type === 'run_aborted')
      if (aborted) {
        rows.push({
          label: t('中断'),
          ok: false,
          duration: '',
          note: aborted.reason ?? '',
          output: '',
          lead: false,
          at: aborted.at,
        })
      }
      // 按事件时间重排：交接必须落在两位成员之间，不能统一沉到底部。
      rows.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
      // 只有真实写过收口事件才算「已结束」；进程崩溃 / 应用重启后账本停在半截，
      // 不能默认显示成已结束（旧格式日志没有 type，按已结束处理）。
      const ended = events.some(
        (e) => e.type === 'run_end' || e.note === 'plan-only' || (!e.type && !!e.member),
      )
      // 仍在跑：没写收口事件且最后一条事件在超时窗口内（与后端 running 判定一致）。
      const lastAt = events.reduce((n, e) => Math.max(n, e.at ?? 0), 0)
      const live = !ended && !aborted && !cancelled && Date.now() - lastAt < 120_000
      return { runId, rows, aborted: !!aborted, ended, cancelled, live }
    })
})

onMounted(() => {
  void refresh()
  // 团队卡要标出「专家已被删除」的悬空成员，所以候选清单要在列表阶段就加载。
  void loadCandidates()
})
</script>

<template>
  <section class="agent-ops teams" :class="{ embedded }">
    <RuntimeNote />

    <header class="aops-head">
      <div class="aops-title">
        <h1>{{ t('多智能体团队') }}</h1>
        <p class="muted">{{ t('协调器调度多名专家完成多步任务。成员直接复用已接入的能力系统（专家 / 技能 / 连接器）—— 即「专家·技能·连接器」那一块。建好的团队可在对话里用') }}<code>team_dispatch</code>{{ t('调度。') }}</p>
      </div>
      <div class="aops-meta">
        <span class="badge">{{ t('{0} 支 · {1} 名成员', [activeTeams.length, memberCount]) }}</span>
        <AppButton variant="icon" class="tool-btn" :disabled="busy" :title="t('刷新')" :aria-label="t('刷新团队')" @click="refresh()">
          <AppIcon name="refresh" :size="14" />
        </AppButton>
      </div>
    </header>

    <div class="aops-toolbar">
      <AppButton variant="primary" class="btn primary" @click="openDialog()">
        <AppIcon name="plus" :size="14" />{{ t('新建团队') }}</AppButton>
      <span v-if="status" class="aops-status" :class="{ err: statusError }">{{ status }}</span>
    </div>

    <ul
      v-if="busy && !teams.length"
      class="team-list"
      role="status"
      :aria-label="t('正在加载团队…')"
    >
      <li v-for="n in 3" :key="n" class="sk-card">
        <span class="skeleton sk-line tall w-40"></span>
        <span class="skeleton sk-line w-80"></span>
        <span class="skeleton sk-line w-60"></span>
        <span class="sk-chips">
          <span class="skeleton sk-chip"></span>
          <span class="skeleton sk-chip"></span>
          <span class="skeleton sk-chip"></span>
        </span>
        <span class="skeleton sk-line w-30"></span>
      </li>
    </ul>

    <ul v-else-if="activeTeams.length" class="team-list">
      <li v-for="entry in activeTeams" :key="entry.id" class="team-card">
        <div class="team-top">
          <AppIcon name="users" :size="16" />
          <span class="team-name">{{ entry.name }}</span>
          <span v-if="entry.running" class="strat">{{ t('运行中') }}</span>
          <span class="strat">{{ strategyText(entry.strategy) }}</span>
        </div>
        <div class="team-members">
          <span
            v-for="m in entry.members"
            :key="m"
            class="chip"
            :class="{ lead: m === (entry.lead ?? entry.members[0]), missing: isDangling(m) }"
            :title="isDangling(m) ? t('该专家已不存在，调度会被拦下；请恢复专家或移除该成员') : undefined"
          >
            {{ labelOf(m) }}
          </span>
        </div>
        <div class="team-foot">
          <span class="team-fact">{{ t('牵头 {0}', [labelOf(entry.lead ?? entry.members[0])]) }}</span>
          <span class="team-fact">{{ failureText(entry.on_failure) }}</span>
          <span class="team-fact">{{ t('调度 {0} 次', [entry.runs]) }}</span>
          <AppButton variant="text" size="sm" class="team-runs" @click="openRuns(entry)">{{ t('运行记录') }}</AppButton>
          <AppButton variant="text" size="sm" @click="openEdit(entry)">{{ t('编辑') }}</AppButton>
          <AppButton variant="danger" size="sm" @click="requestDelete(entry)">{{ t('删除') }}</AppButton>
        </div>
      </li>
    </ul>

    <div v-else-if="!statusError" class="empty-state">
      <div class="empty-icon"><AppIcon name="users" :size="20" /></div>
      <p class="empty-title">{{ t('还没有团队') }}</p>
      <p class="empty-hint">{{ t('点「新建团队」从专家 / 技能 / 连接器里挑成员组队，或在对话里用') }}<code>/team</code>{{ t('查看。') }}</p>
    </div>

    <section v-if="deletedTeams.length" class="deleted-teams">
      <p class="deleted-title">{{ t('已删除团队（历史运行记录保留）') }}</p>
      <ul class="team-list">
        <li v-for="entry in deletedTeams" :key="entry.id" class="team-card deleted">
          <div class="team-top">
            <AppIcon name="users" :size="16" />
            <span class="team-name">{{ entry.name }}</span>
            <span class="strat">{{ t('已删除') }}</span>
          </div>
          <div class="team-foot">
            <span class="team-fact">{{ t('调度 {0} 次', [entry.runs]) }}</span>
            <AppButton variant="text" size="sm" class="team-runs" @click="openRuns(entry)">{{ t('运行记录') }}</AppButton>
          </div>
        </li>
      </ul>
    </section>

    <AppModal
      :open="dialog"
      :title="dialogMode === 'edit' ? t('编辑团队') : t('新建团队')"
      size="md"
      @close="dialog = false"
    >
      <label class="aops-row">
        <span>{{ t('团队名') }}</span>
        <AppInput v-model="formName" :placeholder="t('例如 发布小队')" />
      </label>
      <label class="aops-row">
        <span>{{ t('协调策略') }}</span>
        <AppSelect v-model="formStrategy" :options="strategyOptions" />
      </label>
      <label class="aops-row">
        <span>{{ t('牵头人') }}</span>
        <AppSelect
          v-model="formLead"
          :options="leadOptions"
          :placeholder="t('默认第一位成员')"
        />
      </label>
      <label class="aops-row">
        <span>{{ t('成员失败时') }}</span>
        <AppSelect v-model="formOnFailure" :options="failureOptions" />
      </label>

      <div class="dialog-block">
        <span class="dialog-block-label">{{ t('成员（来自能力系统）') }}</span>
        <div class="member-pick">
          <div class="cand-list">
            <AppButton
              v-for="c in candidates"
              :key="c.key"
              variant="chip"
              class="cand"
              :class="{ on: selected.includes(c.key) }"
              :aria-pressed="selected.includes(c.key)"
              @click="toggle(c.key)"
            >
              <AppIcon :name="c.icon" :size="13" /> {{ c.label }}
              <i class="cand-kind">{{ c.kind }}</i>
            </AppButton>
            <span v-if="candLoading" class="cand-hint">{{ t('读取候选中…') }}</span>
            <span v-else-if="!candidates.length" class="cand-hint">{{ t('暂无可用专家 / 技能 / 连接器') }}</span>
          </div>
          <AppInput v-model="formCustom" :placeholder="t('或手动补充成员，逗号分隔')" />
          <div v-if="selected.length" class="picked">
            <span class="cand-label">{{ t('已选 {0}', [selected.length]) }}</span>
            <span v-for="m in selected" :key="m" class="chip closeable" @click="toggle(m)">
              {{ labelOf(m) }} <AppIcon name="close" :size="11" />
            </span>
          </div>
        </div>
      </div>

      <template #footer>
        <AppButton variant="text" class="aops-plain" @click="dialog = false">{{ t('取消') }}</AppButton>
        <AppButton variant="primary" class="btn primary" @click="submit()">
          {{ dialogMode === 'edit' ? t('保存') : t('创建') }}
        </AppButton>
      </template>
    </AppModal>

    <AppModal
      :open="!!deleteTarget"
      :title="t('删除团队 · {0}', [deleteTarget?.name ?? ''])"
      size="sm"
      @close="deleteTarget = null"
    >
      <p class="muted">{{ t('删除后团队不再出现在列表里，也不能再被调度；此前的运行记录会保留可查。') }}</p>
      <p v-if="deleteTarget?.running" class="run-badge bad delete-warn">
        {{ t('该团队正在运行。直接删除不会中断正在跑的子进程；建议先取消运行。') }}
      </p>
      <p v-if="deleteNotice" class="muted">{{ deleteNotice }}</p>
      <template #footer>
        <AppButton variant="text" class="aops-plain" :disabled="deleteBusy" @click="deleteTarget = null">{{ t('放弃') }}</AppButton>
        <AppButton
          v-if="deleteTarget?.running"
          variant="secondary"
          :disabled="deleteBusy"
          @click="cancelActiveForDelete()"
        >
          {{ t('先取消运行') }}
        </AppButton>
        <AppButton variant="danger" :disabled="deleteBusy" @click="confirmDelete()">{{ t('仍要删除') }}</AppButton>
      </template>
    </AppModal>

    <AppModal
      :open="runsOpen"
      :title="t('运行记录 · {0}', [runsTeam?.name ?? ''])"
      size="lg"
      @close="closeRuns()"
    >
      <div class="runs-head">
        <span class="muted">{{ t('打开期间每 2.5 秒自动刷新；成员产出来自真实调度日志。') }}</span>
        <AppButton variant="text" size="sm" :disabled="runsLoading" @click="loadRuns()">{{ t('刷新') }}</AppButton>
      </div>
      <p v-if="runsNotice" class="runs-notice">{{ runsNotice }}</p>
      <p v-if="!runsEvents.length && !runsLoading" class="runs-empty">
        {{ t('还没有调度记录。在对话里用 team_dispatch 派发一次任务后，这里会按成员显示状态、耗时与产出。') }}
      </p>
      <div v-for="run in runsGrouped" :key="run.runId" class="run-block">
        <div class="run-head">
          <code>#{{ run.runId }}</code>
          <span v-if="run.cancelled" class="run-badge warn">{{ t('已取消') }}</span>
          <span v-else-if="run.aborted" class="run-badge bad">{{ t('已中断') }}</span>
          <span v-else-if="run.ended" class="run-badge">{{ t('已结束') }}</span>
          <span v-else class="run-badge warn">{{ t('未收口') }}</span>
          <AppButton
            v-if="run.live"
            variant="text"
            size="sm"
            class="run-cancel"
            :disabled="cancelling === run.runId"
            @click="cancelRun(run.runId)"
          >
            {{ cancelling === run.runId ? t('取消中…') : t('取消运行') }}
          </AppButton>
        </div>
        <div v-for="(row, i) in run.rows" :key="i" class="run-row">
          <span
            class="run-dot"
            :class="row.cancelled ? 'live' : row.ok === null ? 'live' : row.ok ? 'ok' : 'bad'"
          ></span>
          <span class="run-name">
            {{ row.label }}
            <i v-if="row.lead" class="run-lead">{{ t('牵头') }}</i>
          </span>
          <span v-if="row.note" class="run-note">{{ row.note }}</span>
          <span v-if="row.duration" class="run-dur">{{ row.duration }}</span>
          <p v-if="row.output" class="run-output">{{ row.output }}</p>
        </div>
      </div>
    </AppModal>
  </section>
</template>

<style src="./TeamsView.css" scoped></style>
