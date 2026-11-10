<script setup lang="ts">
import { t } from '@/i18n'
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
import AppButton from '@/components/ui/AppButton.vue'
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
const statusError = ref(false)
const dialog = ref(false)

const candidates = ref<Candidate[]>([])
const candLoading = ref(false)
const selected = ref<string[]>([])
const formCustom = ref('')
const formName = ref('')
const formStrategy = ref('sequential')

const strategyOptions = computed(() => [
  { value: 'sequential', label: t('顺序 sequential') },
  { value: 'parallel', label: t('并行 parallel') },
  { value: 'debate', label: t('辩论 debate') },
])

const strategyText = (s: string | null) =>
  ({ sequential: t('顺序'), parallel: t('并行'), debate: t('辩论') })[s ?? 'sequential'] ?? s ?? t('顺序')

async function refresh() {
  busy.value = true
  status.value = ''
  statusError.value = false
  try {
    teams.value = await agentTeamsList()
  } catch (e) {
    status.value = String(e)
    statusError.value = true
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
  selected.value = []
  formCustom.value = ''
  formName.value = ''
  formStrategy.value = 'sequential'
  status.value = ''
  statusError.value = false
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
    status.value = t('请填写团队名')
    return
  }
  const custom = formCustom.value
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
  const members = Array.from(new Set([...selected.value, ...custom]))
  if (!members.length) {
    status.value = t('请至少选择 / 填写一名成员')
    return
  }
  try {
    const team = await agentTeamCreate(name, members, formStrategy.value)
    status.value = t('已创建团队「{0}」', [team.name])
    dialog.value = false
    await refresh()
  } catch (e) {
    status.value = String(e)
    statusError.value = true
  }
}

onMounted(refresh)
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
        <span class="badge">{{ t('{0} 支 · {1} 名成员', [teams.length, memberCount]) }}</span>
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

    <p v-if="busy && !teams.length" class="load-state">{{ t('正在加载团队…') }}</p>

    <ul v-else-if="teams.length" class="team-list">
      <li v-for="entry in teams" :key="entry.id" class="team-card">
        <div class="team-top">
          <AppIcon name="users" :size="16" />
          <span class="team-name">{{ entry.name }}</span>
          <span class="strat">{{ strategyText(entry.strategy) }}</span>
        </div>
        <div class="team-members">
          <span v-for="m in entry.members" :key="m" class="chip">{{ m }}</span>
        </div>
        <div class="team-foot muted">{{ t('调度记录 {0} 次', [entry.runs]) }}</div>
      </li>
    </ul>

    <div v-else class="aops-empty">
      <AppIcon name="users" :size="36" />
      <strong>{{ t('还没有团队') }}</strong>
      <span class="muted">{{ t('点「新建团队」从专家 / 技能 / 连接器里挑成员组队，或在对话里用') }}<code>/team</code>{{ t('查看。') }}</span>
    </div>

    <AppModal :open="dialog" :title="t('新建团队')" size="md" @close="dialog = false">
      <label class="aops-row">
        <span>{{ t('团队名') }}</span>
        <AppInput v-model="formName" :placeholder="t('例如 发布小队')" />
      </label>
      <label class="aops-row">
        <span>{{ t('协调策略') }}</span>
        <AppSelect v-model="formStrategy" :options="strategyOptions" />
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
              :class="{ on: selected.includes(c.label) }"
              :aria-pressed="selected.includes(c.label)"
              @click="toggle(c.label)"
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
              {{ m }} <AppIcon name="close" :size="11" />
            </span>
          </div>
        </div>
      </div>

      <template #footer>
        <AppButton variant="text" class="aops-plain" @click="dialog = false">{{ t('取消') }}</AppButton>
        <AppButton variant="primary" class="btn primary" @click="submit()">{{ t('创建') }}</AppButton>
      </template>
    </AppModal>
  </section>
</template>

<style src="./TeamsView.css" scoped></style>
