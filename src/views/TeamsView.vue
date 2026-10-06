<script setup lang="ts">
/**
 * 多智能体团队（团队编排运行态）。
 *
 * 读取 Rust 后端 `agent_teams_list`；新建走 `agent_team_create`（脱离 Pi 也能建，
 * 建出的团队定义会被 Pi 工具 `team_create`/`team_dispatch` 读取，形成人面 + agent 面闭环）。
 *
 * 成员不再手敲：候选直接来自当前已接入的能力系统——专家（experts_list）、
 * 技能（skills_list）、连接器（connectors_list），即「专家·技能·连接器」那一块。
 * 这正是用户预期的多智能体团队 = 上面要融合的专家能力块。
 */
import { computed, onMounted, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import RuntimeNote from '@/components/runtime/RuntimeNote.vue'
import { expertsList, type ExpertSummary } from '@/composables/useExperts'
import { connectorsList, type ConnectorSummary } from '@/composables/useConnectors'
import { agentTeamsList, agentTeamCreate, type TeamEntry } from '@/composables/useAgentOps'

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
const dialog = ref(false)

const candidates = ref<Candidate[]>([])
const candLoading = ref(false)
const selected = ref<string[]>([])
const formCustom = ref('')
const formName = ref('')
const formStrategy = ref('sequential')

const strategyOptions = [
  { value: 'sequential', label: '顺序 sequential' },
  { value: 'parallel', label: '并行 parallel' },
  { value: 'debate', label: '辩论 debate' },
]

const strategyText = (s: string | null) =>
  ({ sequential: '顺序', parallel: '并行', debate: '辩论' })[s ?? 'sequential'] ?? s ?? '顺序'

async function refresh() {
  busy.value = true
  status.value = ''
  try {
    teams.value = await agentTeamsList()
  } catch (e) {
    status.value = String(e)
  }
  busy.value = false
}

async function loadCandidates() {
  candLoading.value = true
  try {
    const [exps, skills, cons] = await Promise.all([
      expertsList().catch(() => [] as ExpertSummary[]),
      invoke<SkillEntry[]>('skills_list', { root: null }).catch(() => [] as SkillEntry[]),
      connectorsList().catch(() => [] as ConnectorSummary[]),
    ])
    const list: Candidate[] = []
    for (const e of exps) list.push({ key: `e:${e.id}`, label: e.name || e.id, kind: '专家', icon: 'sparkles' })
    for (const s of skills) list.push({ key: `s:${s.name}`, label: s.name, kind: '技能', icon: 'puzzle' })
    for (const c of cons) list.push({ key: `c:${c.id}`, label: c.title || c.server_name, kind: '连接器', icon: 'plug' })
    candidates.value = list
  } catch {
    candidates.value = []
  }
  candLoading.value = false
}

function openDialog() {
  if (!candidates.value.length) void loadCandidates()
  selected.value = []
  formCustom.value = ''
  formName.value = ''
  formStrategy.value = 'sequential'
  status.value = ''
  dialog.value = true
}

function toggle(label: string) {
  const i = selected.value.indexOf(label)
  if (i >= 0) selected.value.splice(i, 1)
  else selected.value.push(label)
}

const memberCount = computed(() => teams.value.reduce((n, t) => n + (t.members?.length ?? 0), 0))

async function submit() {
  const name = formName.value.trim()
  if (!name) {
    status.value = '请填写团队名'
    return
  }
  const custom = formCustom.value
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
  const members = Array.from(new Set([...selected.value, ...custom]))
  if (!members.length) {
    status.value = '请至少选择 / 填写一名成员'
    return
  }
  try {
    const t = await agentTeamCreate(name, members, formStrategy.value)
    status.value = `已创建团队「${t.name}」`
    dialog.value = false
    await refresh()
  } catch (e) {
    status.value = String(e)
  }
}

onMounted(refresh)
</script>

<template>
  <section class="agent-ops teams" :class="{ embedded }">
    <RuntimeNote />

    <header class="aops-head">
      <div class="aops-title">
        <h1>多智能体团队</h1>
        <p class="muted">
          协调器调度多名专家完成多步任务。成员直接复用已接入的能力系统（专家 / 技能 / 连接器）——
          即「专家·技能·连接器」那一块。建好的团队可在对话里用 <code>team_dispatch</code> 调度。
        </p>
      </div>
      <div class="aops-meta">
        <span class="badge">{{ teams.length }} 支 · {{ memberCount }} 名成员</span>
        <button class="tool-btn" :disabled="busy" title="刷新" @click="refresh()">
          <AppIcon name="refresh" :size="14" />
        </button>
      </div>
    </header>

    <div class="aops-toolbar">
      <button class="btn primary" @click="openDialog()">
        <AppIcon name="plus" :size="14" /> 新建团队
      </button>
      <span v-if="status" class="aops-status" :class="{ err: status.startsWith('请') }">{{ status }}</span>
    </div>

    <ul v-if="teams.length" class="team-list">
      <li v-for="t in teams" :key="t.id" class="team-card">
        <div class="team-top">
          <AppIcon name="users" :size="16" />
          <span class="team-name">{{ t.name }}</span>
          <span class="strat">{{ strategyText(t.strategy) }}</span>
        </div>
        <div class="team-members">
          <span v-for="m in t.members" :key="m" class="chip">{{ m }}</span>
        </div>
        <div class="team-foot muted">调度记录 {{ t.runs }} 次</div>
      </li>
    </ul>

    <div v-else class="aops-empty">
      <AppIcon name="users" :size="36" />
      <strong>还没有团队</strong>
      <span class="muted">点「新建团队」从专家 / 技能 / 连接器里挑成员组队，或在对话里用 <code>/team</code> 查看。</span>
    </div>

    <AppModal :open="dialog" title="新建团队" size="md" @close="dialog = false">
      <label class="aops-row">
        <span>团队名</span>
        <AppInput v-model="formName" placeholder="例如 发布小队" />
      </label>
      <label class="aops-row">
        <span>协调策略</span>
        <AppSelect v-model="formStrategy" :options="strategyOptions" />
      </label>

      <div class="dialog-block">
        <span class="dialog-block-label">成员（来自能力系统）</span>
        <div class="member-pick">
          <div class="cand-list">
            <button
              v-for="c in candidates"
              :key="c.key"
              type="button"
              class="cand"
              :class="{ on: selected.includes(c.label) }"
              @click="toggle(c.label)"
            >
              <AppIcon :name="c.icon" :size="13" /> {{ c.label }}
              <i class="cand-kind">{{ c.kind }}</i>
            </button>
            <span v-if="candLoading" class="cand-hint">读取候选中…</span>
            <span v-else-if="!candidates.length" class="cand-hint">暂无可用专家 / 技能 / 连接器</span>
          </div>
          <AppInput v-model="formCustom" placeholder="或手动补充成员，逗号分隔" />
          <div v-if="selected.length" class="picked">
            <span class="cand-label">已选 {{ selected.length }}</span>
            <span v-for="m in selected" :key="m" class="chip closeable" @click="toggle(m)">
              {{ m }} <AppIcon name="close" :size="11" />
            </span>
          </div>
        </div>
      </div>

      <template #footer>
        <button class="aops-plain" @click="dialog = false">取消</button>
        <button class="btn primary" @click="submit()">创建</button>
      </template>
    </AppModal>
  </section>
</template>

<style src="./TeamsView.css" scoped></style>
