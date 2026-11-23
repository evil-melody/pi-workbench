import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { ref } from 'vue'

/**
 * worktree 引擎的前端封装：状态总览 + 创建/合并/清理 + 外部 agent 派发。
 *
 * agent 输出走 `wt://agent-output` / `wt://agent-done` 流式事件，按 id 配对。
 * 多个 agent 并行时各自持有独立缓冲，互不串流。
 */
export interface WorktreeInfo {
  branch: string
  path: string
  is_main: boolean
  dirty: number
  ahead: number
  behind: number
  base: string
  last_commit: string
  last_commit_at: number
  port: number
}

export interface DiffFile {
  path: string
  adds: number
  dels: number
}

export interface DiffSummary {
  files: DiffFile[]
  commits: string[]
}

export interface MergeOutcome {
  steps: string[]
  cleaned: boolean
}

export interface AgentLaunch {
  branch: string
  agent: 'claude' | 'codex' | 'pi' | 'custom'
  prompt: string
  custom_cmd?: string
}

/** 单个 agent 运行流的展示状态。 */
export interface AgentRun {
  id: string
  branch: string
  lines: string[]
  running: boolean
  code?: number
}

/** 全局共享：面板与派发表单读同一份，避免多处轮询。 */
export const agentRuns = ref<AgentRun[]>([])

let unlisteners: UnlistenFn[] | null = null

/** 挂事件监听（幂等：重复调用只挂一次）。 */
export async function ensureAgentListeners() {
  if (unlisteners) return
  unlisteners = [
    await listen<{ id: string; line: string }>('wt://agent-output', (e) => {
      const run = agentRuns.value.find((r) => r.id === e.payload.id)
      if (run) run.lines.push(e.payload.line)
    }),
    await listen<{ id: string; code: number }>('wt://agent-done', (e) => {
      const run = agentRuns.value.find((r) => r.id === e.payload.id)
      if (run) {
        run.running = false
        run.code = e.payload.code
      }
    }),
  ]
}

/**
 * 后端正常返回数组，但 IPC 桩/异常路径可能给回 null —— 归一化成空数组，
 * 否则模板里的 `items.length` 会把整棵子树渲染打断（面板直接消失）。
 */
export const wtList = (root: string) =>
  invoke<WorktreeInfo[]>('wt_list', { root }).then((r) => r ?? [])

export const wtCreate = (root: string, branch: string, base?: string) =>
  invoke<WorktreeInfo>('wt_create', { root, branch, base: base ?? null })

export const wtRemove = (root: string, branch: string, force = false) =>
  invoke<null>('wt_remove', { root, branch, force })

export const wtMerge = (root: string, branch: string, target?: string) =>
  invoke<MergeOutcome>('wt_merge', { root, branch, target: target ?? null })

export const wtDiff = (root: string, branch: string) =>
  invoke<DiffSummary>('wt_diff', { root, branch }).then((r) => ({
    files: r?.files ?? [],
    commits: r?.commits ?? [],
  }))

let agentSeq = 0

/** 派发外部 agent 到 worktree；返回新的运行流引用供 UI 直接绑定。 */
export async function wtSpawnAgent(root: string, launch: AgentLaunch): Promise<AgentRun> {
  await ensureAgentListeners()
  const id = `wt-agent-${Date.now()}-${++agentSeq}`
  const run: AgentRun = { id, branch: launch.branch, lines: [], running: true }
  agentRuns.value.push(run)
  await invoke('wt_agent', { root, launch: { ...launch, custom_cmd: launch.custom_cmd ?? '' }, id })
  return run
}

// ---------- 舰队看板 ----------

export interface FleetLane {
  branch: string
  path: string
  /** 流 id（`<fleet>:<branch>`），与 agentRuns 缓冲配对。 */
  id: string
  status: 'running' | 'done' | 'failed'
  exit_code: number | null
  started_at: number
  ended_at: number | null
}

export interface FleetRun {
  id: string
  task: string
  agent: string
  lanes: FleetLane[]
  created_at: number
  updated_at: number
}

export interface FleetLaunch {
  task: string
  agent: 'claude' | 'codex' | 'pi' | 'custom'
  custom_cmd?: string
  branches: string[]
}

/** 一次派发 N 条 lane；流 id 形如 `<fleet>:<branch>`，前端按前缀归组。 */
export async function wtFleetLaunch(
  root: string,
  launch: FleetLaunch,
): Promise<FleetRun> {
  await ensureAgentListeners()
  const fleetId = `fleet-${Date.now()}-${++agentSeq}`
  const run = await invoke<FleetRun>('wt_fleet_launch', {
    root,
    launch: { ...launch, custom_cmd: launch.custom_cmd ?? '' },
    fleet_id: fleetId,
  })
  for (const lane of run?.lanes ?? []) {
    agentRuns.value.push({ id: lane.id, branch: lane.branch, lines: [], running: true })
  }
  return run
}

export const wtFleetList = (root: string) =>
  invoke<FleetRun[]>('wt_fleet_list', { root }).then((r) => r ?? [])

// ---------- 合并冲突预测 ----------

export interface ConflictPair {
  a: string
  b: string
  file: string
  lines: Array<[number, number]>
  level: 'high' | 'medium'
}

export const wtConflicts = (root: string) =>
  invoke<ConflictPair[]>('wt_conflicts', { root }).then((r) => r ?? [])
