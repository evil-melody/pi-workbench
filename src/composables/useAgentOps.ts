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
const NEED_TAURI =
  '需在桌面 App（pnpm tauri dev）中运行：浏览器预览没有 Tauri 通道，该操作不会落盘。'

function read<T>(cmd: string, fallback: T): Promise<T> {
  if (!isTauriRuntime()) return Promise.resolve(fallback)
  return invoke<T>(cmd)
}

function write<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) return Promise.reject(new Error(NEED_TAURI))
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
  ts: number
  text: string
  tags: string[]
}

export interface SkillPoolEntry {
  name: string
  description: string
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
export const agentSkillPoolList = () => read<SkillPoolEntry[]>('agent_skillpool_list', [])
export const agentBrowserStatus = () => read<BrowserStatus>('agent_browser_status', { active: false })

// 管理（写，脱离内核也能用；写出的状态会被对应 Pi 工具读取）。
export const agentTeamCreate = (name: string, members: string[], strategy?: string) =>
  write<TeamEntry>('agent_team_create', { name, members, strategy: strategy ?? null })
export const agentMemoryStore = (text: string, tags: string[]) =>
  write<MemoryEntry>('agent_memory_store', { text, tags })
export const agentSkillPublish = (name: string, description: string, body: string) =>
  write<SkillPoolEntry>('agent_skill_publish', { name, description, body })
export const agentBrowserOpen = (url: string) =>
  write<BrowserStatus>('agent_browser_open', { url })
