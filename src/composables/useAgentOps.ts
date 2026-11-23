import { t } from '@/i18n'
import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from '@/composables/useRuntime'

/**
 * 智能体运行层的前端封装（团队 / 记忆 / 技能池 / 浏览器会话）。
 *
 * 这四个域的读写在后端走 Tauri 命令；纯浏览器（`pnpm dev` / 构建产物直开）
 * 没有 IPC，直接 `invoke` 会抛出 `Cannot read properties of undefined (reading 'invoke')`
 * 这类底层 TypeError，被视图 catch 后原样显示在界面上——用户看到的就是一串
 * 无意义报错，而不是「为什么不能用」。
 *
 * 这里按语义分流：
 *   · 读：返回空值，让页面走空态，解释交给顶部的 RuntimeNote 横幅；
 *   · 写：抛一条可读的中文错误，因为写操作确实没有发生，不能假装成功。
 */
const needTauri = () =>
  t('需在桌面 App（pnpm tauri dev）中运行：浏览器预览没有 Tauri 通道，该操作不会落盘。')

function read<T>(cmd: string, fallback: T): Promise<T> {
  if (!isTauriRuntime()) return Promise.resolve(fallback)
  // 后端可能回 null（Option 序列化 / 桩未实现）：fallback 只在「非 Tauri」时用，
  // 这里补上「返回 null」这一路，否则页面的 `.length` 直接把组件渲染打断。
  return invoke<T>(cmd).then((r) => r ?? fallback)
}

function write<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) return Promise.reject(new Error(needTauri()))
  return invoke<T>(cmd, args)
}

export interface TeamEntry {
  id: string
  name: string
  members: string[]
  strategy: string | null
  /** 牵头人（成员键）；旧团队为空。 */
  lead: string | null
  /** stop / continue / retry */
  on_failure: string | null
  /** 人工关卡成员（LoopForge human-gate）：这些成员开跑前必须有人放行。 */
  gates?: string[]
  /** 成员级执行器 / 模型覆盖：{ 成员键: { executor?, model? } }。 */
  member_overrides?: Record<string, { executor?: string; model?: string }>
  created_at: number | null
  /** 最近一次编辑时间；旧定义没有。 */
  updated_at?: number | null
  /** 已删除（软删除）：定义不可再调度，运行日志仍可查。 */
  deleted?: boolean
  /** 有未收口的运行（120s 内有事件且没写 run_end）。 */
  running?: boolean
  active_run_id?: string | null
  runs: number
}

/** 待放行的人工关卡（扩展落盘，面板读取）。 */
export interface TeamGate {
  runId: string
  member: string
  label: string
  team: string
  at: number
  /** 磁盘文件名，面板放行时后端按它写 decision。 */
  file?: string
}

/** 团队调度日志的一行：成员产出行或运行摘要行（IPC 侧字段，磁盘日志的 `runId` 由后端映射为 `run_id`）。 */
export interface TeamRunEvent {
  type?: string
  run_id?: string
  member?: string
  label?: string
  ok?: boolean
  lead?: boolean
  output?: string
  duration_ms?: number
  /** 该成员进程消耗的 token（Pi json 模式 message_end.usage）。 */
  tokens?: number
  attempts?: number
  from?: string
  to?: string
  aborted?: boolean
  cancelled?: boolean
  reason?: string
  at?: number
  round?: number
  strategy?: string
  real?: boolean
  note?: string
  /** 关卡决策：approve / reject / timeout（gate_decision 事件）。 */
  decision?: string
  /** 重放来源：本次是重放哪次运行的哪个成员（team_replay 写入）。 */
  replay_of?: string
  /** 关卡驳回 / 超时：成员本次未执行。 */
  skipped?: boolean
}

export interface MemoryEntry {
  id: string
  ts: number
  text: string
  tags: string[]
  source?: string
  job_id?: string
}

/** 待撤销条目：删除后 24 小时内可恢复，到期由调度 tick 硬失效。 */
export interface MemoryTrashEntry extends MemoryEntry {
  deleted_at: number
  purge_at: number
}

/** 画像字段：由记忆保留标签折叠，只读视图。 */
export interface ProfileField {
  value: string
  evidence: string[]
  updated_at: number
}

export interface MemoryProfile {
  preference?: ProfileField
  taboo?: ProfileField
  goal?: ProfileField
  workflow?: ProfileField
  generated_at: number
  source_mtime: number
}

export interface SkillPoolEntry {
  name: string
  description: string
}

export interface MemoryVecHit {
  id: string
  text: string
  tags: string
  distance: number
  score: number
}
export interface MemoryVecStatus {
  table: string
  exists: boolean
  rows: number
  embedding: { base_url: string; model: string }
  agent_tool_note: string
}
export interface MemoryVecReindexResult {
  indexed: number
  skipped: number
  errors: string[]
}

export interface BrowserStatus {
  active: boolean
  url?: string
  method?: string
  at?: number
  shot?: string
  [k: string]: unknown
}

// 查询（读）：非 Tauri 时返回空值，页面走空态。
export const agentTeamsList = () => read<TeamEntry[]>('agent_teams_list', [])
export const agentTeamRuns = (teamId: string) =>
  isTauriRuntime()
    ? invoke<TeamRunEvent[]>('agent_team_runs', { team_id: teamId }).then((r) => r ?? [])
    : Promise.resolve([] as TeamRunEvent[])
export const agentMemoryList = () => read<MemoryEntry[]>('agent_memory_list', [])
export const agentMemoryTrash = () => read<MemoryTrashEntry[]>('agent_memory_trash', [])
export const agentSkillPoolList = () => read<SkillPoolEntry[]>('agent_skillpool_list', [])
export const agentBrowserStatus = () => read<BrowserStatus>('agent_browser_status', { active: false })

// 管理（写，脱离内核也能用；写出的状态会被对应 Pi 工具读取）。
export const agentTeamCreate = (
  name: string,
  members: string[],
  strategy?: string,
  lead?: string,
  onFailure?: string,
  gates?: string[],
  memberOverrides?: Record<string, { executor?: string; model?: string }>,
) =>
  write<TeamEntry>('agent_team_create', {
    name,
    members,
    strategy: strategy ?? null,
    lead: lead ?? null,
    on_failure: onFailure ?? null,
    gates: gates ?? null,
    member_overrides: memberOverrides ?? null,
  })
/** 编辑团队定义：只改磁盘，正在跑的实例持有旧定义快照，下次调度才用新定义。 */
export const agentTeamUpdate = (
  id: string,
  name: string,
  members: string[],
  strategy?: string,
  lead?: string,
  onFailure?: string,
  gates?: string[],
  memberOverrides?: Record<string, { executor?: string; model?: string }>,
) =>
  write<TeamEntry>('agent_team_update', {
    id,
    name,
    members,
    strategy: strategy ?? null,
    lead: lead ?? null,
    on_failure: onFailure ?? null,
    gates: gates ?? null,
    member_overrides: memberOverrides ?? null,
  })
/** 软删除：定义不再可调度，`<id>.jsonl` 历史运行记录保留可查。 */
export const agentTeamDelete = (id: string) =>
  write<{ id: string; deleted: boolean; runs_preserved: boolean }>('agent_team_delete', { id })
/** 请求取消一次运行：Extension 轮询标记文件并真正 kill 成员子进程。 */
export const agentTeamCancelRun = (teamId: string, runId?: string) =>
  write<{ run_id: string; at: number }>('agent_team_cancel', {
    team_id: teamId,
    run_id: runId ?? null,
  })
/** 待放行关卡：扩展阻塞在 awaitGate 时面板能看到这条。 */
export const agentTeamGates = (teamId: string) =>
  isTauriRuntime()
    ? invoke<TeamGate[]>('agent_team_gates', { team_id: teamId }).then((r) => r ?? [])
    : Promise.resolve([] as TeamGate[])
/** 关卡放行 / 驳回：写 decision 文件，扩展轮询到即继续。 */
export const agentTeamGateDecide = (
  teamId: string,
  member: string,
  decision: 'approve' | 'reject',
  runId?: string,
) =>
  write<{ member: string; decision: string }>('agent_team_gate_decide', {
    team_id: teamId,
    member,
    decision,
    run_id: runId ?? null,
  })
export const agentMemoryStore = (text: string, tags: string[]) =>
  write<MemoryEntry>('agent_memory_store', { text, tags })
/** 删除记忆：进入 24 小时待撤销态，召回立即不可见。返回删除后的有效列表。 */
export const agentMemoryForget = (id: string) =>
  write<MemoryEntry[]>('agent_memory_forget', { id })
/** 撤销删除：恢复为有效记忆。返回恢复后的有效列表。 */
export const agentMemoryRestore = (id: string) =>
  write<MemoryEntry[]>('agent_memory_restore', { id })
/** 立即永久删除：跳过 24 小时窗口，写审计后不可恢复。 */
export const agentMemoryPurge = (id: string) =>
  write<MemoryEntry[]>('agent_memory_purge', { id })
/** 更正记忆：追加 update 事件，原行保留作审计。 */
export const agentMemoryUpdate = (id: string, text: string, tags: string[]) =>
  write<MemoryEntry[]>('agent_memory_update', { id, text, tags })
/** 用户画像：由记忆保留标签折叠出的只读视图。 */
export const agentProfileGet = () =>
  read<MemoryProfile>('agent_profile_get', { generated_at: 0, source_mtime: 0 })
export const agentSkillPublish = (name: string, description: string, body: string) =>
  write<SkillPoolEntry>('agent_skill_publish', { name, description, body })

// 记忆语义向量层（B5，Rust/LanceDB 侧；供外壳消费，agent 内 memory_recall 仍词面）。
export const memoryVecStatus = () =>
  read<MemoryVecStatus>('memory_vec_status', {
    table: 'memory_vectors',
    exists: false,
    rows: 0,
    embedding: { base_url: '', model: '' },
    agent_tool_note: '',
  })
export const memoryVecSearch = (query: string, topK?: number) =>
  write<MemoryVecHit[]>('memory_vec_search', { query, top_k: topK })
export const memoryVecReindex = () =>
  write<MemoryVecReindexResult>('memory_vec_reindex', {})

export const agentBrowserOpen = (url: string) =>
  write<BrowserStatus>('agent_browser_open', { url })
