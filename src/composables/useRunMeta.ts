import { invoke } from '@tauri-apps/api/core'
import { ref } from 'vue'

/**
 * 运行记录元数据（run_meta sidecar）的前端封装。
 *
 * 后端契约（src-tauri 并行开发中，前端按契约调用）：
 * - `run_meta_list` → RunMetaEntry[]：全量 sidecar 记录
 * - `run_meta_update({ cwd, index, patch })` → RunMetaEntry[]：单条打补丁，
 *   返回合并后的全量 entries（前端直接本地刷新，不再回头 list）
 *
 * 这里不合并 journal 段数据（那是 listRunHistory 的职责），只维护
 * pinned/title/archived/deleted 四个标记位。
 */

/** sidecar 的一条记录（与后端 RunMetaEntry 逐字段对齐）。 */
export interface RunMetaEntry {
  cwd: string
  /** journal 全局段号。 */
  index: number
  pinned: boolean
  /** 用户重命名后的标题；缺省 = 用 journal 首条用户消息。 */
  title?: string
  archived: boolean
  /** 软删除：列表默认过滤，不落盘删除。 */
  deleted: boolean
}

/** run_meta_update 的补丁：只写给出的字段，未给出的保持原值。 */
export interface RunMetaPatch {
  pinned?: boolean
  title?: string
  archived?: boolean
  deleted?: boolean
}

/** 批量操作的目标定位（cwd + 段号）。 */
export interface RunMetaTarget {
  cwd: string
  index: number
}

/** 注入型 invoke（测试可替换）；默认走 Tauri IPC。 */
type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

export function useRunMeta(invokeFn: InvokeFn = invoke as InvokeFn) {
  const entries = ref<RunMetaEntry[]>([])
  const loading = ref(false)

  /** 拉取全量 sidecar。失败不抛（列表整体降级为「无元数据」），返回当前 entries。 */
  async function refresh(): Promise<RunMetaEntry[]> {
    loading.value = true
    try {
      const list = await invokeFn<RunMetaEntry[]>('run_meta_list')
      entries.value = Array.isArray(list) ? list : []
    } catch {
      entries.value = []
    } finally {
      loading.value = false
    }
    return entries.value
  }

  /** 单条打补丁；返回值为后端合并后的全量 entries，直接替换本地副本。 */
  async function update(
    cwd: string,
    index: number,
    patch: RunMetaPatch,
  ): Promise<RunMetaEntry[]> {
    const list = await invokeFn<RunMetaEntry[]>('run_meta_update', { cwd, index, patch })
    entries.value = Array.isArray(list) ? list : entries.value
    return entries.value
  }

  /**
   * 批量打同一补丁：后端一次只收一条，这里逐条 invoke（顺序执行，避免
   * sidecar 并发写互相覆盖）。全部结束后才刷新本地 entries——
   * 调用方随后统一刷新记录列表，N 条记录只触发一次列表重读。
   */
  async function updateMany(
    targets: readonly RunMetaTarget[],
    patch: RunMetaPatch,
  ): Promise<RunMetaEntry[]> {
    let last: RunMetaEntry[] = entries.value
    for (const t of targets) {
      last = await invokeFn<RunMetaEntry[]>('run_meta_update', {
        cwd: t.cwd,
        index: t.index,
        patch,
      })
    }
    entries.value = Array.isArray(last) ? last : entries.value
    return entries.value
  }

  return { entries, loading, refresh, update, updateMany }
}
