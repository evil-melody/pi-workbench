<script setup lang="ts">
import { t } from '@/i18n'
/**
 * 智能体分道：把「这一轮到底谁在跑」画成可读的时间轴。
 *
 * 两路真事实：
 *   · 主理人 —— 共享的 `pi://event` 流。桥侧已补 runId / spanId / 起止时间，
 *     主理人链路交给 `RunGraph`（与轨迹页签里的节点图同一个组件，不另造一套）。
 *   · 团队   —— `.pi/teams/<id>.jsonl`，每个成员一条起止 + 全文产出。
 *
 * 团队成员子进程（pi --mode chat）不回结构化事件，所以只有起止与产出；
 * 顺序策略的成员间按执行顺序标「交接」，并行 / 辩论不标。
 * 缺失的成员工具级事件与真实 handoff 数据在底部明写，不拿假数据补洞。
 */
import { computed, onMounted, ref, watch } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppSelect, { type SelectOption } from '@/components/ui/AppSelect.vue'
import RunGraph from '@/components/chat/RunGraph.vue'
import { usePiEventsInjected } from '@/composables/usePiEvents'
import { agentTeamRuns, agentTeamsList, type TeamEntry, type TeamRunEvent } from '@/composables/useAgentOps'
import { buildRunChains } from '@/utils/runChain'
import type { ActivityState } from '@/composables/useActivity'

const props = defineProps<{ state: ActivityState; running: boolean }>()

const stream = usePiEventsInjected()
const events = computed(() => stream?.events.value ?? [])

/** 主理人链路：与 MessageList 共用同一个折算函数，只取最近 12 条。 */
const chains = computed(() => buildRunChains(events.value).slice(-12))

function clock(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/* ── 团队分道：读调度日志，按 runId 归并成一次运行 ───────────────── */

interface MemberLane {
  key: string
  name: string
  ok: boolean
  output: string
  at: number
  round: number
}

interface TeamRun {
  runId: string
  at: number
  strategy: string
  real: boolean
  plan: boolean
  members: MemberLane[]
}

const teams = ref<TeamEntry[]>([])
const teamId = ref('')
const runs = ref<TeamRunEvent[]>([])
const loading = ref(false)
const expanded = ref(new Set<string>())

const teamOptions = computed<SelectOption[]>(() =>
  teams.value.map((x) => ({
    value: x.id,
    label: `${x.name || x.id} · ${x.runs} ${t('次')}`,
  })),
)

const teamRuns = computed<TeamRun[]>(() => {
  const map = new Map<string, TeamRun>()
  for (const e of runs.value) {
    const id = String(e.run_id ?? '')
    if (!id) continue
    let run = map.get(id)
    if (!run) {
      run = { runId: id, at: Number(e.at ?? 0), strategy: '', real: false, plan: false, members: [] }
      map.set(id, run)
    }
    const at = Number(e.at ?? 0)
    if (at && (!run.at || at < run.at)) run.at = at
    if (typeof e.strategy === 'string') run.strategy = e.strategy
    if (e.real === true) run.real = true
    if (e.note === 'plan-only') run.plan = true
    if (typeof e.member === 'string') {
      run.members.push({
        key: `${id}-${e.member}-${run.members.length}`,
        name: e.member,
        ok: e.ok === true,
        output: String(e.output ?? ''),
        at,
        round: Number(e.round ?? 0),
      })
    }
  }
  return [...map.values()].sort((a, b) => b.at - a.at).slice(0, 6)
})

function strategyText(s: string): string {
  const table: Record<string, string> = { sequential: t('顺序'), parallel: t('并行'), debate: t('辩论') }
  return table[s] ?? s ?? ''
}

async function loadTeams() {
  try {
    const list = await agentTeamsList()
    teams.value = Array.isArray(list) ? list : []
  } catch {
    teams.value = []
  }
  if (!teamId.value && teams.value.length) {
    teamId.value = (teams.value.find((x) => x.runs > 0) ?? teams.value[0]).id
  }
}

async function loadRuns() {
  if (!teamId.value) {
    runs.value = []
    return
  }
  loading.value = true
  try {
    const list = await agentTeamRuns(teamId.value)
    runs.value = Array.isArray(list) ? list : []
  } catch {
    runs.value = []
  } finally {
    loading.value = false
  }
}

watch(teamId, loadRuns)

onMounted(async () => {
  await loadTeams()
  await loadRuns()
})

function toggleOutput(key: string) {
  const next = new Set(expanded.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expanded.value = next
}

function excerpt(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > 220 ? `${one.slice(0, 220)}…` : one
}

const missingNote = computed(() => {
  const bits: string[] = []
  if (!events.value.length) bits.push(t('主理人：还没有内核事件'))
  if (!teamRuns.value.length) bits.push(t('团队：尚无调度记录'))
  return bits
})
</script>

<template>
  <div class="agent-lanes">
    <header class="al-head">
      <AppIcon name="users" :size="14" />
      <span class="al-title">{{ t('智能体分道') }}</span>
      <span class="al-phase" :class="`ph-${props.state.phase}`">{{ props.running ? t('运行中') : t('空闲') }}</span>
    </header>

    <section class="al-section">
      <div class="al-sec-head">
        <AppIcon name="cpu" :size="13" />
        <span>{{ t('主理人') }}</span>
        <span class="al-sec-meta" v-if="chains.length">{{ t('{0} 轮', [chains.length]) }}</span>
      </div>

      <div v-if="chains.length" class="al-chains">
        <RunGraph v-for="chain in chains" :key="chain.runId" :chain="chain" compact />
      </div>

      <div v-else class="al-empty-state">
        <AppIcon name="cpu" :size="16" />
        <p>{{ props.running ? t('内核已启动，等待第一条事件') : t('发起一轮对话后，这里会按轮次展开执行步骤') }}</p>
      </div>
    </section>

    <section class="al-section">
      <div class="al-sec-head">
        <AppIcon name="layers" :size="13" />
        <span>{{ t('团队分道') }}</span>
        <span v-if="teams.length" class="al-sec-meta">{{ t('{0} 支团队', [teams.length]) }}</span>
      </div>

      <div v-if="teams.length" class="al-team-pick">
        <AppSelect v-model="teamId" :options="teamOptions" :placeholder="t('选择团队')" width="100%" />
        <AppButton variant="icon" class="al-refresh" :title="t('刷新调度日志')" :aria-label="t('刷新调度日志')" @click="loadRuns">
          <AppIcon name="refresh" :size="13" />
        </AppButton>
      </div>

      <p v-if="loading" class="al-empty">{{ t('正在读取调度日志…') }}</p>

      <div v-else-if="teamRuns.length" class="al-runs">
        <article v-for="run in teamRuns" :key="run.runId" class="al-run">
          <header class="al-run-head">
            <span class="al-run-id">#{{ run.runId }}</span>
            <span v-if="run.strategy" class="al-chip">{{ strategyText(run.strategy) }}</span>
            <span v-if="run.plan" class="al-chip warn">{{ t('仅计划') }}</span>
            <span class="al-time">{{ run.at ? clock(run.at) : '' }}</span>
          </header>

          <template v-for="(m, mi) in run.members" :key="m.key">
            <div class="al-lane" :class="{ bad: !m.ok }">
              <span class="al-lane-dot" />
              <div class="al-lane-body">
                <div class="al-lane-head">
                  <span class="al-lane-name">{{ m.name }}</span>
                  <span v-if="m.round" class="al-chip">{{ t('第 {0} 轮', [m.round]) }}</span>
                  <span class="al-lane-status" :class="{ ok: m.ok }">{{ m.ok ? t('产出') : t('未跑通') }}</span>
                </div>
                <p class="al-lane-out" :class="{ full: expanded.has(m.key) }">{{ expanded.has(m.key) ? m.output : excerpt(m.output) }}</p>
                <AppButton v-if="m.output.length > 220" variant="text" class="al-more" @click="toggleOutput(m.key)">
                  {{ expanded.has(m.key) ? t('收起') : t('展开全文') }}
                </AppButton>
              </div>
            </div>
            <!-- 顺序策略下的成员是逐个跑的：两者之间就是一次真实交接点。 -->
            <div v-if="run.strategy === 'sequential' && mi < run.members.length - 1" class="al-handoff">
              <AppIcon name="arrow-right" :size="10" />
              <span>{{ t('交接：{0} → {1}', [m.name, run.members[mi + 1].name]) }}</span>
            </div>
          </template>
        </article>
      </div>

      <div v-else class="al-empty-state">
        <AppIcon name="layers" :size="16" />
        <p>{{ teams.length ? t('该团队还没有调度记录') : t('还没有团队。专家团队建好后，调度记录会在这里按成员分道展示') }}</p>
      </div>
    </section>

    <p v-if="missingNote.length" class="al-footnote">
      <span v-for="n in missingNote" :key="n">{{ n }}</span>
    </p>
    <p class="al-footnote">
      {{ t('粒度说明：主理人来自内核事件（请求 / 模型 / 工具 / 工具门 / 重试，含环节耗时）；团队成员目前只有起止与全文产出，工具级事件与真实 handoff 数据尚未采集。') }}
    </p>
  </div>
</template>

<style src="./AgentLanes.css" scoped></style>
