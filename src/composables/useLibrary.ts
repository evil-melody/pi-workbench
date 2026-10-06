/**
 * 资料库域前端封装。
 *
 * 命令签名与 Rust 侧一致（camelCase 入参）：
 *   library_list / library_marks / library_stats / library_tree
 *   library_read / library_write / library_create / library_import
 *   library_rename / library_move / library_remove / library_set_enabled
 *   library_publish / library_reindex / library_revisions / library_rollback
 *   library_search / library_open
 *
 * 界面上必须体现的四条语义（不是「记一下」，是真会报错的）：
 *   1. 停用的资产读正文一律被拒（library/disabled），历史任务引用也不例外；
 *   2. 草稿必须显式发布才进检索，草稿本身不参与搜索；
 *   3. 转换器失败只标记「不可搜索」，原件完好无损；
 *   4. 单文件 50 MiB / 合计 5 GiB 由后端卡，前端只负责显示用量。
 */
import { invoke } from '@tauri-apps/api/core'

export type AssetKind = 'markdown' | 'text' | 'html' | 'pdf' | 'docx' | 'pptx' | 'other'

export interface AssetOrigin {
  kind: string
  detail: string
}

export interface LibraryAssetView {
  id: string
  name: string
  /** 相对资料库根目录的路径，如 `docs/report.md`。 */
  rel_path: string
  /** 所在目录，根级为 `/`。 */
  dir: string
  kind: AssetKind
  size: number
  enabled: boolean
  searchable: boolean
  /** 转换失败原因；只在 `searchable === false` 时有意义。 */
  convert_error?: string | null
  revision: number
  draft: boolean
  origin: AssetOrigin
  updated_at: number
}

export interface LibraryNode {
  name: string
  path: string
  is_dir: boolean
  /** 该条目是否已在资产表里登记。 */
  asset_id?: string | null
  size: number
  children?: LibraryNode[]
}

export interface LibraryHit {
  asset_id: string
  name: string
  dir: string
  kind: AssetKind
  origin: AssetOrigin
  revision: number
  size: number
  /** ready | failed | skipped */
  convert_status: string
  location: string | null
  snippet: string
  score: number
}

export interface LibraryContent {
  content: string
  truncated: boolean
  total_bytes: number
}

export interface LibraryStats {
  asset_count: number
  used_bytes: number
  max_file_bytes: number
  max_total_bytes: number
}

export interface LibraryRevision {
  asset_id: string
  rev: number
  at: number
  size: number
}

/** 来源文案：写清楚这条资料是怎么进来的，别让用户猜。 */
export const ORIGIN_TEXT: Record<string, string> = {
  created: '新建',
  imported: '导入',
  written: '正文保存',
  'draft-published': '草稿发布',
  rollback: '回滚',
}

export const KIND_TEXT: Record<string, string> = {
  markdown: 'Markdown',
  text: '文本',
  html: 'HTML',
  pdf: 'PDF',
  docx: 'Word',
  pptx: 'PPT',
  other: '其它',
}

export const CONVERT_TEXT: Record<string, string> = {
  ready: '可检索',
  failed: '转换失败',
  skipped: '未转换',
}

export function describeLibraryError(err: unknown, fallback = '操作失败'): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  if (!raw) return fallback
  // 浏览器预览没有 Tauri IPC，invoke 会抛底层 TypeError；转成可读说明，
  // 而不是让它退化成一无所指的「操作失败」。
  if (raw.includes("reading 'invoke'") || raw.includes('__TAURI_INTERNALS__')) {
    return '需在桌面 App（pnpm tauri dev）中运行：浏览器预览没有 Tauri 通道，资料库不可用。'
  }
  if (raw.includes('library/disabled')) return '该资料已停用，启用后才能读取正文'
  if (raw.includes('library/not-found')) return '资料不存在，可能已被删除'
  if (raw.includes('library/already-registered')) return '同一位置已经有同名资料了'
  if (raw.includes('library/path-taken')) return '目标位置已存在同名文件'
  if (raw.includes('library/path-invalid')) return '路径不合法：不允许空段、. 或 ..'
  if (raw.includes('library/name-invalid')) return '名称不合法：不能含路径分隔符，且不能以点开头'
  if (raw.includes('library/name-required')) return '请填写名称'
  if (raw.includes('library/file-too-large')) return '文件超过 50 MiB 上限'
  if (raw.includes('library/quotas-exceeded')) return '超过资料库 5 GiB 合计上限'
  if (raw.includes('library/binary-body')) return '该格式不按文本读取，请用「打开原件」'
  if (raw.includes('library/revision-missing')) return '该修订的快照已被清理'
  if (raw.includes('library/source-missing')) return '导入的源文件已不存在'
  if (raw.includes('library/missing')) return '原件缺失，可能已被外部删除'
  return fallback
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${bytes} B`
}

export function formatTime(ms: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const libraryList = () => invoke<LibraryAssetView[]>('library_list')

export const libraryMarks = (kind: 'recent' | 'written') =>
  invoke<LibraryAssetView[]>('library_marks', { kind })

export const libraryStats = () => invoke<LibraryStats>('library_stats')

export const libraryTree = (dir: string) =>
  invoke<LibraryNode[]>('library_tree', { dir: dir || '/' })

export const libraryRead = (id: string) => invoke<LibraryContent>('library_read', { id })

export const libraryWrite = (id: string, content: string) =>
  invoke<LibraryAssetView>('library_write', { id, content })

export const libraryCreate = (dir: string, name: string, content: string) =>
  invoke<LibraryAssetView>('library_create', { dir, name, content })

export const libraryImport = (path: string, dir: string) =>
  invoke<LibraryAssetView>('library_import', { path, dir })

export const libraryRename = (id: string, name: string) =>
  invoke<LibraryAssetView>('library_rename', { id, name })

export const libraryMove = (id: string, targetDir: string) =>
  invoke<LibraryAssetView>('library_move', { id, targetDir })

export const libraryRemove = (id: string) => invoke<void>('library_remove', { id })

export const librarySetEnabled = (id: string, enabled: boolean) =>
  invoke<LibraryAssetView>('library_set_enabled', { id, enabled })

export const libraryPublish = (id: string) =>
  invoke<LibraryAssetView>('library_publish', { id })

export const libraryReindex = (id: string) =>
  invoke<LibraryAssetView>('library_reindex', { id })

export const libraryRevisions = (id: string) =>
  invoke<LibraryRevision[]>('library_revisions', { id })

export const libraryRollback = (id: string, rev: number) =>
  invoke<LibraryAssetView>('library_rollback', { id, rev })

export const librarySearch = (query: string) =>
  invoke<LibraryHit[]>('library_search', { query })

export const libraryOpen = (id: string) => invoke<void>('library_open', { id })
