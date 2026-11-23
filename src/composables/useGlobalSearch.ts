/**
 * 全局搜索（D-21）数据层。
 *
 * 四源并行预取：会话 / 项目 / 记忆在面板打开时一次拉取并缓存；
 * 文件走 `library_search`，输入 150ms 防抖后查询（后端全文索引，无法本地预取）。
 *
 * ponytail: 记忆只做词面过滤。`memoryVecSearch` 需要嵌入模型、首查延迟高，
 * 对「边打边看」的命令面板不划算；升级路径是 vecStatus.ready 时并联一路
 * 语义命中，与词面结果按 score 合并（后端已返回 score）。
 */
import { ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { t } from '@/i18n'
import { timeAgo } from '@/utils/timeAgo'
import { agentMemoryList, type MemoryEntry } from './useAgentOps'
import { librarySearch, type LibraryHit } from './useLibrary'
import type { Project } from './useProject'
import { listRunHistory, type RunRecord } from './useReplay'

export type HitKind = 'session' | 'project' | 'file' | 'memory'

/** 一条命中。payload 字段按 kind 取用，整体可序列化，可直接写进最近项。 */
export interface PaletteHit {
  key: string
  kind: HitKind
  title: string
  meta: string
  snippet: string
  cwd?: string
  index?: number
  projectId?: string
  query?: string
}

/** 面板开合状态：侧栏按钮与 ⌘K 共用一份。 */
export const paletteOpen = ref(false)
export function openPalette() {
  paletteOpen.value = true
}
export function closePalette() {
  paletteOpen.value = false
}

/** 分组限额：会话/项目/文件/记忆。 */
const LIMITS: Record<HitKind, number> = { session: 5, project: 5, file: 8, memory: 5 }
const RECENT_KEY = 'pi-workbench:search-recent'
const RECENT_LIMIT = 8

function loadRecents(): PaletteHit[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(raw) ? raw.slice(0, RECENT_LIMIT) : []
  } catch {
    return []
  }
}

export const recents = ref<PaletteHit[]>(loadRecents())

/** 记住一次进入：同一条只留最新一次，整体上限 8。 */
export function rememberHit(hit: PaletteHit) {
  const next = [hit, ...recents.value.filter((r) => r.key !== hit.key)].slice(0, RECENT_LIMIT)
  recents.value = next
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // 隐私模式禁写 localStorage：最近项只在本会话内有效。
  }
}

let sessions: RunRecord[] = []
let projects: Project[] = []
let memories: MemoryEntry[] = []
let projectFailed = false
let memoryFailed = false

/** 打开面板时并行预取三个可本地过滤的来源。 */
export async function prefetchPalette() {
  const [s, p, m] = await Promise.allSettled([
    listRunHistory(),
    invoke<Project[]>('projects_list'),
    agentMemoryList(),
  ])
  sessions = s.status === 'fulfilled' ? s.value : []
  projectFailed = p.status === 'rejected'
  projects = p.status === 'fulfilled' && Array.isArray(p.value) ? p.value : []
  memoryFailed = m.status === 'rejected'
  memories = m.status === 'fulfilled' && Array.isArray(m.value) ? m.value : []
}

export interface PaletteOutcome {
  hits: PaletteHit[]
  /** 四源全失败：只有在 Tauri 下后端整体不可达时才会为 true。 */
  error: boolean
}

const lower = (text: string) => text.toLowerCase()
const has = (text: string, term: string) => lower(text).includes(term)

function rankOf(text: string, term: string): number {
  const s = lower(text)
  return s.startsWith(term) ? 2 : s.includes(term) ? 1 : 0
}

/** 前缀命中优先，其余保持来源原有顺序（稳定排序）。 */
function rank<T>(items: T[], term: string, text: (item: T) => string): T[] {
  return [...items].sort((a, b) => rankOf(text(b), term) - rankOf(text(a), term))
}

function sessionHit(s: RunRecord): PaletteHit {
  return {
    key: `session:${s.cwd}:${s.index}`,
    kind: 'session',
    title: s.title || t('（未命名运行记录）'),
    meta: [s.cwd, timeAgo(s.endedAtMs ?? s.startedAtMs)].filter(Boolean).join(' · '),
    snippet: '',
    cwd: s.cwd,
    index: s.index,
  }
}

function projectHit(p: Project): PaletteHit {
  return {
    key: `project:${p.id}`,
    kind: 'project',
    title: p.name,
    meta: p.path ?? '',
    snippet: p.description ?? '',
    projectId: p.id,
  }
}

function fileHit(f: LibraryHit, query: string): PaletteHit {
  return {
    key: `file:${f.asset_id}`,
    kind: 'file',
    title: f.name,
    meta: [f.dir, f.kind].filter(Boolean).join(' · '),
    snippet: f.snippet || '',
    query,
  }
}

function memoryHit(m: MemoryEntry): PaletteHit {
  const text = m.text.replace(/\s+/g, ' ').trim()
  return {
    key: `memory:${m.id}`,
    kind: 'memory',
    title: text.length > 90 ? `${text.slice(0, 90)}…` : text,
    meta: [m.tags.join(' · '), timeAgo(m.ts)].filter(Boolean).join(' · '),
    snippet: '',
  }
}

/**
 * 一次查询。空查询直接返回最近项，不发任何 IPC。
 * 文件源失败不影响其余三源；只有四源都拿不到数据才标 error。
 */
export async function searchPalette(raw: string): Promise<PaletteOutcome> {
  const term = raw.trim().toLowerCase()
  if (!term) return { hits: [...recents.value], error: false }

  let fileFailed = false
  let files: LibraryHit[] = []
  try {
    files = await librarySearch(raw.trim())
  } catch {
    fileFailed = true
  }

  const sessionHits = rank(
    sessions.filter((s) => has(s.title, term) || has(s.cwd, term)),
    term,
    (s) => s.title,
  )
    .slice(0, LIMITS.session)
    .map(sessionHit)

  const projectHits = rank(
    projects.filter((p) => has(p.name, term) || has(p.description ?? '', term) || has(p.path ?? '', term)),
    term,
    (p) => p.name,
  )
    .slice(0, LIMITS.project)
    .map(projectHit)

  const fileHits = rank(
    (Array.isArray(files) ? files : []).filter((f) => has(f.name, term) || has(f.snippet, term)),
    term,
    (f) => f.name,
  )
    .slice(0, LIMITS.file)
    .map((f) => fileHit(f, raw.trim()))

  const memoryHits = rank(
    memories.filter((m) => has(m.text, term) || has(m.tags.join(' '), term)),
    term,
    (m) => m.text,
  )
    .slice(0, LIMITS.memory)
    .map(memoryHit)

  const hits = [...sessionHits, ...projectHits, ...fileHits, ...memoryHits]
  const noData = sessions.length === 0 && projects.length === 0 && memories.length === 0
  return { hits, error: fileFailed && projectFailed && memoryFailed && noData }
}
