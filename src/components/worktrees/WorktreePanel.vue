<script setup lang="ts">
/**
 * Worktree 工作区面板（会话内嵌）。
 *
 * 定位：并行 agent 的执行面属于「当前会话的工作环境」，不是一级页面——
 * 所以它挂在对话页的过程抽屉里，与轨迹 / 智能体 / 工作流同层。
 *
 * 业界参照（Worktrunk / Claude Code --worktree / Paradev）：
 * - 分支名寻址：一张卡 = 一个分支 = 一个 worktree = 一个 agent 会话；
 * - 状态即一等信息：dirty / ahead / behind / 端口 / 最近提交直接铺在卡上；
 * - 合并是一条链（squash → 清理），不是三步手敲；
 * - 端口是 worktree 的属性（后端 hash 分配），dev server 冲突从这里杜绝。
 */
import { t } from '@/i18n'
import { activeProjectPath } from '@/composables/useProject'
import {
  agentRuns,
  wtConflicts,
  wtCreate,
  wtDiff,
  wtFleetLaunch,
  wtFleetList,
  wtList,
  wtMerge,
  wtRemove,
  wtSpawnAgent,
  type ConflictPair,
  type DiffSummary,
  type FleetRun,
  type WorktreeInfo,
} from '@/composables/useWorktrees'
import { invoke } from '@tauri-apps/api/core'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppSelect from '@/components/ui/AppSelect.vue'

const props = defineProps<{
  /** 仓库根目录；不传时用当前活动项目路径。 */
  root?: string
  /** 当前会话的内核工作目录：命中的卡片标为「当前会话」。 */
  cwd?: string
}>()

/** 「在此对话」：把会话切进这个 worktree（内核 cwd 需重启，由 ChatView 处理）。 */
const emit = defineEmits<{ enter: [payload: { path: string; branch: string }] }>()

const items = ref<WorktreeInfo[]>([])
const loading = ref(false)
const error = ref('')
const notices = ref<string[]>([])

// 创建表单
const newBranch = ref('')
const creating = ref(false)

// diff 展开：branch → 概览
const diffs = ref<Record<string, DiffSummary>>({})
const diffOpen = ref(new Set<string>())

// agent 派发表单
const agentKind = ref<'pi' | 'claude' | 'codex' | 'custom'>('pi')
const agentPrompt = ref('')
const customCmd = ref('')
const dispatching = ref(false)

// 并行舰队：一 prompt → N worktree → N agent（业界核心动作，
// Claude Code subagents / Cursor best-of-n 同型）。
const fleetOpen = ref(false)
const fleetPrefix = ref('task')
const fleetCount = ref(3)
const fleetKind = ref<'pi' | 'claude' | 'codex' | 'custom'>('pi')
const fleetPrompt = ref('')
const fleetCustom = ref('')
const fleetBusy = ref(false)

// 舰队看板：一次派发 = 一个 fleet run，N 条 lane 各有独立状态。
// 数据来自 wt_fleet_list（内存表 + 磁盘账本合并，重启可回放）。
const fleets = ref<FleetRun[]>([])
const fleetBoardOpen = ref(new Set<string>())

// 合并冲突预测（Clash 思路）：worktree 两两求 hunk 行区间交集，
// 合并前先亮红灯，避免「合了才发现炸」。
const conflicts = ref<ConflictPair[]>([])

const root = computed(() => props.root?.trim() || activeProjectPath.value.trim())
const hasRoot = computed(() => root.value.length > 0)

const agentOptions = computed(() => [
  { value: 'pi', label: 'Pi (pi -p)', hint: t('内置内核') },
  { value: 'claude', label: 'Claude Code (claude -p)' },
  { value: 'codex', label: 'Codex (codex exec)' },
  { value: 'custom', label: t('自定义命令') },
])

async function refresh() {
  if (!hasRoot.value) {
    items.value = []
    fleets.value = []
    conflicts.value = []
    return
  }
  loading.value = true
  error.value = ''
  try {
    items.value = await wtList(root.value)
  } catch (e) {
    error.value = toText(e)
    items.value = []
  } finally {
    loading.value = false
  }
  // 看板与冲突预测失败不阻塞主列表：它们是附加情报，不是主数据。
  try {
    fleets.value = await wtFleetList(root.value)
  } catch {
    fleets.value = []
  }
  try {
    conflicts.value = await wtConflicts(root.value)
  } catch {
    conflicts.value = []
  }
}

// 有 lane 在跑时每 4s 静默刷新看板（lane 状态由后端线程回写，前端只读）。
let fleetTimer: ReturnType<typeof setInterval> | null = null
const anyRunning = computed(() =>
  fleets.value.some((f) => f.lanes.some((l) => l.status === 'running')),
)
watch(anyRunning, (run) => {
  if (run && !fleetTimer) {
    fleetTimer = setInterval(async () => {
      if (!hasRoot.value) return
      try {
        fleets.value = await wtFleetList(root.value)
      } catch {
        /* 静默：下一轮再试 */
      }
    }, 4000)
  } else if (!run && fleetTimer) {
    clearInterval(fleetTimer)
    fleetTimer = null
  }
})
onUnmounted(() => {
  if (fleetTimer) clearInterval(fleetTimer)
  fleetTimer = null
})

function toggleBoard(id: string) {
  const next = new Set(fleetBoardOpen.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  fleetBoardOpen.value = next
}

/** lane 的运行流缓冲（与单卡派发共用 agentRuns，按流 id 配对）。 */
const laneRun = (laneId: string) => agentRuns.value.find((r) => r.id === laneId)

function fleetTally(f: FleetRun) {
  const done = f.lanes.filter((l) => l.status === 'done').length
  const failed = f.lanes.filter((l) => l.status === 'failed').length
  const running = f.lanes.filter((l) => l.status === 'running').length
  return { done, failed, running, total: f.lanes.length }
}

/** 跨全部舰队的 lane 汇总：一次看清总条数、在跑、成功率。 */
const fleetTotal = computed(() => {
  const lanes = fleets.value.flatMap((f) => f.lanes)
  const done = lanes.filter((l) => l.status === 'done').length
  const failed = lanes.filter((l) => l.status === 'failed').length
  const running = lanes.filter((l) => l.status === 'running').length
  const settled = done + failed
  return {
    runs: fleets.value.length,
    total: lanes.length,
    done,
    failed,
    running,
    rate: settled ? Math.round((done / settled) * 100) : null,
  }
})

/** 重放：拿原任务原文再发一轮（LoopForge 节点重放思路的最简形态）。 */
async function relaunchFleet(f: FleetRun) {
  if (!hasRoot.value || fleetBusy.value) return
  fleetBusy.value = true
  error.value = ''
  try {
    // 保留原 agent（claude/codex/pi），不再一律退回 pi——重放应重现原执行器。
    // custom 的命令行没进 FleetRun 结构，后端补字段前暂以 pi 兜底。
    const agent = (['claude', 'codex', 'pi'].includes(f.agent) ? f.agent : 'pi') as 'claude' | 'codex' | 'pi'
    await wtFleetLaunch(root.value, {
      task: f.task,
      agent,
      branches: f.lanes.map((l) => l.branch),
    })
    fleets.value = await wtFleetList(root.value)
    note(t('舰队已重放：{n} 条 lane', { n: f.lanes.length }))
  } catch (e) {
    error.value = toText(e)
  } finally {
    fleetBusy.value = false
  }
}

/** 某个分支的冲突预警条目（合并按钮旁的红灯依据）。 */
const conflictsFor = (branch: string) =>
  conflicts.value.filter((c) => c.a === branch || c.b === branch)

function toText(e: unknown) {
  return String((e as { message?: string })?.message ?? e)
}

function note(msg: string) {
  notices.value.push(msg)
  setTimeout(() => notices.value.shift(), 6000)
}

async function create() {
  const branch = newBranch.value.trim()
  if (!branch) return
  creating.value = true
  error.value = ''
  try {
    await wtCreate(root.value, branch)
    newBranch.value = ''
    await refresh()
    note(t('已创建 worktree：{branch}', { branch }))
  } catch (e) {
    error.value = toText(e)
  } finally {
    creating.value = false
  }
}

async function remove(w: WorktreeInfo) {
  error.value = ''
  try {
    await wtRemove(root.value, w.branch, false)
    await refresh()
  } catch (e) {
    // dirty 未加 force：按业界惯例（Worktrunk / Claude Code）先问一次再强删。
    const msg = toText(e)
    if (msg.includes('force')) {
      if (window.confirm(t('{branch} 有未提交改动，强制删除？', { branch: w.branch }))) {
        try {
          await wtRemove(root.value, w.branch, true)
          await refresh()
        } catch (e2) {
          error.value = toText(e2)
        }
      }
    } else {
      error.value = msg
    }
  }
}

async function merge(w: WorktreeInfo) {
  error.value = ''
  // 高危冲突（行区间相撞）合并前再拦一道：预测不是保证，但至少不让人手滑点过。
  const risky = conflictsFor(w.branch).filter((c) => c.level === 'high')
  if (risky.length && !window.confirm(t('与 {0} 个分支行级相撞，合并很可能冲突。仍要继续？', [risky.length]))) return
  try {
    const out = await wtMerge(root.value, w.branch)
    out.steps.forEach((s) => note(s))
    await refresh()
  } catch (e) {
    error.value = toText(e)
  }
}

async function toggleDiff(w: WorktreeInfo) {
  error.value = ''
  if (diffOpen.value.has(w.branch)) {
    const next = new Set(diffOpen.value)
    next.delete(w.branch)
    diffOpen.value = next
    return
  }
  try {
    diffs.value = { ...diffs.value, [w.branch]: await wtDiff(root.value, w.branch) }
    diffOpen.value = new Set([...diffOpen.value, w.branch])
  } catch (e) {
    error.value = toText(e)
  }
}

async function spawnAgent(w: WorktreeInfo) {
  error.value = ''
  dispatching.value = true
  try {
    await wtSpawnAgent(root.value, {
      branch: w.branch,
      agent: agentKind.value,
      prompt: agentPrompt.value,
      custom_cmd: agentKind.value === 'custom' ? customCmd.value : undefined,
    })
    note(t('已派发到 {branch}，输出见下方运行流', { branch: w.branch }))
  } catch (e) {
    error.value = toText(e)
  } finally {
    dispatching.value = false
  }
}

/** 批量派发：前缀-序号建 worktree（已存在的复用），一次 wt_fleet_launch 起 N 条 lane。 */
async function spawnFleet() {
  const prompt = fleetPrompt.value.trim()
  const prefix =
    (fleetPrefix.value.trim() || 'task')
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'task'
  if (!prompt || !hasRoot.value) return
  fleetBusy.value = true
  error.value = ''
  const count = Math.min(10, Math.max(1, Math.floor(fleetCount.value) || 1))
  const existing = new Set(items.value.map((w) => w.branch))
  const branches: string[] = []
  try {
    for (let i = 1; i <= count; i++) {
      const branch = `${prefix}-${i}`
      if (!existing.has(branch)) {
        await wtCreate(root.value, branch)
        note(t('已创建 worktree：{branch}', { branch }))
      }
      branches.push(branch)
    }
    const run = await wtFleetLaunch(root.value, {
      task: prompt,
      agent: fleetKind.value,
      custom_cmd: fleetKind.value === 'custom' ? fleetCustom.value : undefined,
      branches,
    })
    fleets.value = [run, ...fleets.value.filter((f) => f.id !== run.id)]
    fleetBoardOpen.value = new Set([...fleetBoardOpen.value, run.id])
    note(t('舰队已出发：{n} 个 agent 并行运行', { n: run.lanes.length }))
    await refresh()
  } catch (e) {
    error.value = toText(e)
  } finally {
    fleetBusy.value = false
  }
}

function reveal(w: WorktreeInfo) {
  invoke('reveal_path', { path: w.path }).catch((e) => note(toText(e)))
}

function timeAgo(ts: number) {
  if (!ts) return ''
  const s = Math.max(1, Math.floor(Date.now() / 1000 - ts))
  if (s < 3600) return t('{n} 分钟前', { n: Math.floor(s / 60) })
  if (s < 86400) return t('{n} 小时前', { n: Math.floor(s / 3600) })
  return t('{n} 天前', { n: Math.floor(s / 86400) })
}

const runsFor = (branch: string) => agentRuns.value.filter((r) => r.branch === branch)

onMounted(refresh)
// 活动项目切换后仓库根会变：重列一次，否则面板还挂着上一个仓库的 worktree。
watch(root, refresh)
</script>

<template>
  <section class="wtp">
    <header class="wtp-head">
      <div class="wtp-create">
        <input
          v-model="newBranch"
          class="wtp-input"
          :placeholder="t('新分支名，如 feat-auth')"
          :disabled="!hasRoot"
        />
        <AppButton
          variant="primary"
          size="sm"
          :disabled="!hasRoot || creating || !newBranch.trim()"
          @click="create"
        >
          {{ creating ? t('创建中…') : t('新建') }}
        </AppButton>
      </div>

      <details class="wtp-fleet" :open="fleetOpen" @toggle="fleetOpen = ($event.target as HTMLDetailsElement).open">
        <summary class="wtp-fleet-toggle">{{ t('并行舰队') }}</summary>
        <div class="wtp-fleet-form">
          <AppSelect v-model="fleetKind" :options="agentOptions" width="100%" />
          <div class="wtp-fleet-row">
            <input v-model="fleetPrefix" class="wtp-input" :placeholder="t('分支前缀，如 task')" />
            <input
              v-model="fleetCount"
              class="wtp-input wtp-count"
              type="number"
              min="1"
              max="10"
              :placeholder="t('数量')"
            />
          </div>
          <input
            v-model="fleetPrompt"
            class="wtp-input"
            :placeholder="t('并行任务 prompt')"
          />
          <input
            v-if="fleetKind === 'custom'"
            v-model="fleetCustom"
            class="wtp-input"
            :placeholder="t('命令模板，{prompt} 占位符')"
          />
          <AppButton
            variant="primary"
            size="sm"
            :disabled="!fleetPrompt.trim() || fleetBusy"
            @click="spawnFleet"
          >
            {{ fleetBusy ? t('派发中…') : t('出发') }}
          </AppButton>
        </div>
      </details>

      <p v-if="!hasRoot" class="wtp-hint">
        {{ t('当前会话没有绑定仓库目录。先在顶栏选项目并设置仓库路径。') }}
      </p>
      <p v-if="error" class="wtp-error">{{ error }}</p>
      <ul class="wtp-notices">
        <li v-for="(n, i) in notices" :key="i" class="wtp-notice">{{ n }}</li>
      </ul>

      <!-- 冲突预警横幅：合并前先亮灯（Clash 思路，行区间交集 = 高危） -->
      <div v-if="conflicts.length" class="wtp-clashes">
        <p class="wtp-clashes-title">{{ t('冲突预测：{n} 处重叠', { n: conflicts.length }) }}</p>
        <details v-for="(c, i) in conflicts.slice(0, 4)" :key="i" class="wtp-clash">
          <summary class="wtp-clash-head">
            <span :class="c.level === 'high' ? 'clash-high' : 'clash-medium'">
              {{ c.level === 'high' ? t('行相撞') : t('同文件') }}
            </span>
            <span class="clash-pair">{{ c.a }} × {{ c.b }}</span>
            <span class="clash-file">{{ c.file }}</span>
          </summary>
          <p class="clash-lines">
            {{ t('重叠行区间') }}：
            <code v-for="([s, e], j) in c.lines" :key="j">{{ s }}-{{ e }}<template v-if="j < c.lines.length - 1">、</template></code>
          </p>
        </details>
        <p v-if="conflicts.length > 4" class="wtp-meta">
          {{ t('另有 {n} 处', { n: conflicts.length - 4 }) }}
        </p>
      </div>
    </header>

    <!-- 舰队看板：每次派发一张卡，lane 状态实时（4s 轮询驱动） -->
    <section v-if="fleets.length" class="wtp-fleets">
      <h3 class="wtp-section-title">{{ t('舰队看板') }}</h3>
      <div class="wtp-fleet-total">
        <span>{{ t('{0} 次派发 · {1} 条 lane', [fleetTotal.runs, fleetTotal.total]) }}</span>
        <span v-if="fleetTotal.running" class="tally-run">{{ fleetTotal.running }} {{ t('在跑') }}</span>
        <span class="tally-ok">{{ fleetTotal.done }} ✓</span>
        <span v-if="fleetTotal.failed" class="tally-fail">{{ fleetTotal.failed }} ✗</span>
        <span v-if="fleetTotal.rate !== null" class="wtp-rate">{{ t('成功率 {n}%', { n: fleetTotal.rate }) }}</span>
      </div>
      <article v-for="f in fleets.slice(0, 8)" :key="f.id" class="wtp-fleetcard">
        <button class="wtp-fleet-head" @click="toggleBoard(f.id)">
          <span class="wtp-fleet-caret">{{ fleetBoardOpen.has(f.id) ? '▾' : '▸' }}</span>
          <span class="wtp-fleet-task" :title="f.task">{{ f.task }}</span>
          <span class="wtp-fleet-tally">
            <em v-if="fleetTally(f).running" class="tally-run">
              {{ fleetTally(f).running }} {{ t('在跑') }}
            </em>
            <em v-if="fleetTally(f).done" class="tally-ok">{{ fleetTally(f).done }} ✓</em>
            <em v-if="fleetTally(f).failed" class="tally-fail">{{ fleetTally(f).failed }} ✗</em>
          </span>
        </button>
        <div v-if="fleetBoardOpen.has(f.id)" class="wtp-fleet-body">
          <ul class="wtp-lanes">
            <li v-for="l in f.lanes" :key="l.id" class="wtp-lane">
              <span :class="l.status === 'running' ? 'tally-run' : l.status === 'done' ? 'tally-ok' : 'tally-fail'">
                {{ l.status === 'running' ? '●' : l.status === 'done' ? '✓' : '✗' }}
              </span>
              <span class="lane-branch">{{ l.branch }}</span>
              <span class="lane-meta">
                {{ l.status === 'running' ? t('{n} 行', { n: laneRun(l.id)?.lines.length ?? 0 }) : `exit ${l.exit_code ?? '?'}` }}
              </span>
              <details v-if="laneRun(l.id)?.lines.length" class="wtp-run lane-log">
                <summary>{{ t('lane 输出') }}</summary>
                <pre class="wtp-run-log">{{ laneRun(l.id)!.lines.join('\n') }}</pre>
              </details>
            </li>
          </ul>
          <div class="wtp-fleet-actions">
            <AppButton
              variant="text"
              size="sm"
              :disabled="fleetBusy"
              :title="t('用原任务在所有分支再跑一轮')"
              @click="relaunchFleet(f)"
            >
              {{ t('重放') }}
            </AppButton>
          </div>
        </div>
      </article>
    </section>

    <div class="wtp-list">
      <article v-for="w in items" :key="w.branch" class="wtp-card" :class="{ main: w.is_main }">
        <div class="wtp-id">
          <span class="wtp-branch">{{ w.is_main ? '@' : '^' }} {{ w.branch }}</span>
          <span v-if="w.is_main" class="wtp-badge dim">{{ t('主工作区') }}</span>
          <span v-if="props.cwd && props.cwd === w.path" class="wtp-badge accent">
            {{ t('当前会话') }}
          </span>
          <span v-if="w.dirty" class="wtp-badge warn">{{ t('{n} 处改动', { n: w.dirty }) }}</span>
          <span v-if="w.ahead" class="wtp-badge accent">↑{{ w.ahead }}</span>
          <span v-if="w.behind" class="wtp-badge dim">↓{{ w.behind }}</span>
          <span class="wtp-badge dim">{{ t('端口 {port}', { port: w.port }) }}</span>
        </div>

        <p class="wtp-meta" :title="w.path">
          <template v-if="w.last_commit">{{ w.last_commit }} · {{ timeAgo(w.last_commit_at) }}</template>
        </p>

        <div class="wtp-actions">
          <AppButton
            variant="text"
            size="sm"
            :disabled="props.cwd === w.path"
            :title="t('把当前会话切到这个 worktree（内核工作目录随之改变）')"
            @click="emit('enter', { path: w.path, branch: w.branch })"
          >
            {{ t('在此对话') }}
          </AppButton>
          <AppButton variant="text" size="sm" @click="toggleDiff(w)">
            {{ diffOpen.has(w.branch) ? t('收起') : t('diff') }}
          </AppButton>
          <AppButton
            v-if="!w.is_main"
            variant="text"
            size="sm"
            :class="{ 'merge-risk': conflictsFor(w.branch).some((c) => c.level === 'high') }"
            :title="
              conflictsFor(w.branch).length
                ? t('与 {n} 个分支存在改动重叠，合并前先确认', { n: conflictsFor(w.branch).length })
                : ''
            "
            @click="merge(w)"
          >
            {{ t('合并') }}
            <span
              v-if="conflictsFor(w.branch).some((c) => c.level === 'high')"
              class="merge-risk-dot"
            >!</span>
          </AppButton>
          <AppButton variant="text" size="sm" @click="reveal(w)">{{ t('打开目录') }}</AppButton>
          <AppButton v-if="!w.is_main" variant="text" size="sm" class="danger" @click="remove(w)">
            {{ t('删除') }}
          </AppButton>
        </div>

        <div v-if="diffOpen.has(w.branch)" class="wtp-diff">
          <p v-if="!diffs[w.branch]?.files.length" class="wtp-meta">
            {{ t('相对 {base} 无差异', { base: w.base }) }}
          </p>
          <ul v-else class="wtp-files">
            <li v-for="f in diffs[w.branch].files" :key="f.path" class="wtp-file">
              <span class="wtp-file-path">{{ f.path }}</span>
              <span class="wtp-adds">+{{ f.adds }}</span>
              <span class="wtp-dels">-{{ f.dels }}</span>
            </li>
          </ul>
          <ul v-if="diffs[w.branch]?.commits.length" class="wtp-commits">
            <li v-for="c in diffs[w.branch].commits" :key="c">{{ c }}</li>
          </ul>
        </div>

        <div class="wtp-agent">
          <AppSelect v-model="agentKind" :options="agentOptions" width="100%" />
          <input
            v-model="agentPrompt"
            class="wtp-input"
            :placeholder="t('任务 prompt')"
          />
          <input
            v-if="agentKind === 'custom'"
            v-model="customCmd"
            class="wtp-input"
            :placeholder="t('命令模板，{prompt} 占位符')"
          />
          <AppButton
            variant="primary"
            size="sm"
            :disabled="!agentPrompt.trim() || dispatching"
            @click="spawnAgent(w)"
          >
            {{ t('派发') }}
          </AppButton>
        </div>

        <details v-for="r in runsFor(w.branch)" :key="r.id" class="wtp-run" :open="r.running">
          <summary>
            <span :class="r.running ? 'running' : r.code === 0 ? 'ok' : 'fail'">
              {{ r.running ? '●' : r.code === 0 ? '✓' : '✗' }}
            </span>
            {{ r.lines.length }} {{ t('行') }}
          </summary>
          <pre class="wtp-run-log">{{ r.lines.join('\n') }}</pre>
        </details>
      </article>
      <p v-if="hasRoot && !loading && !items.length" class="wtp-hint">{{ t('该仓库还没有 worktree。') }}</p>
    </div>
  </section>
</template>

<style src="./WorktreePanel.css" scoped></style>
