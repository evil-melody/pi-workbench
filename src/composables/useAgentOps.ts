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
  return invoke<T>(cmd)
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
  created_at: number | null
  runs: number
}

export interface MemoryEntry {
  id: string
  ts: number
  text: string
  tags: string[]
  source?: string
  jobId?: string
}

/** 待撤销条目：删除后 24 小时内可恢复，到期由调度 tick 硬失效。 */
export interface MemoryTrashEntry extends MemoryEntry {
  deletedAt: number
  purgeAt: number
}

/** 画像字段：由记忆保留标签折叠，只读视图。 */
export interface ProfileField {
  value: string
  evidence: string[]
  updatedAt: number
}

export interface MemoryProfile {
  preference?: ProfileField
  taboo?: ProfileField
  goal?: ProfileField
  workflow?: ProfileField
  generatedAt: number
  sourceMtime: number
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
  embedding: { baseUrl: string; model: string }
  agentToolNote: string
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
export const agentMemoryList = () => read<MemoryEntry[]>('agent_memory_list', [])
export const agentMemoryTrash = () => read<MemoryTrashEntry[]>('agent_memory_trash', [])
export const agentSkillPoolList = () => read<SkillPoolEntry[]>('agent_skillpool_list', [])
export const agentBrowserStatus = () => read<BrowserStatus>('agent_browser_status', { active: false })

// 管理（写，脱离内核也能用；写出的状态会被对应 Pi 工具读取）。
export const agentTeamCreate = (name: string, members: string[], strategy?: string) =>
  write<TeamEntry>('agent_team_create', { name, members, strategy: strategy ?? null })
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
  read<MemoryProfile>('agent_profile_get', { generatedAt: 0, sourceMtime: 0 })
export const agentSkillPublish = (name: string, description: string, body: string) =>
  write<SkillPoolEntry>('agent_skill_publish', { name, description, body })

// 记忆语义向量层（B5，Rust/LanceDB 侧；供外壳消费，agent 内 memory_recall 仍词面）。
export const memoryVecStatus = () =>
  read<MemoryVecStatus>('memory_vec_status', {
    table: 'memory_vectors',
    exists: false,
    rows: 0,
    embedding: { baseUrl: '', model: '' },
    agentToolNote: '',
  })
export const memoryVecSearch = (query: string, topK?: number) =>
  write<MemoryVecHit[]>('memory_vec_search', { query, top_k: topK })
export const memoryVecReindex = () =>
  write<MemoryVecReindexResult>('memory_vec_reindex', {})

export const agentBrowserOpen = (url: string) =>
  write<BrowserStatus>('agent_browser_open', { url })
