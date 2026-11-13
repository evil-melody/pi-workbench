/**
 * 主动任务 / 收件箱前端通道。
 *
 * 后端 `proactive.rs` 是唯一数据源：任务账本、状态机、未读数都由 Rust 计算，
 * 前端只做展示与指令下发，不在本地另存一份账，避免两边对不上。
 * 调度器每次状态变化都会 emit `proactive://changed`，这里只负责刷新未读角标。
 */
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { ref } from 'vue'

export type JobStatus = 'pending' | 'running' | 'failed' | 'done' | 'interrupted'

export interface ProactiveGrant {
  bash_allow: string[]
  write_roots: string[]
  max_tool_calls: number
}

export interface ProactiveJob {
  id: string
  title: string
  prompt: string
  cwd: string
  interval_secs: number
  next_at: number
  enabled: boolean
  status: JobStatus
  attempts: number
  max_attempts: number
  last_run_at?: number | null
  last_error?: string | null
  grant: ProactiveGrant
}

export interface InboxItem {
  id: string
  job_id: string
  title: string
  body: string
  created_at: number
  read: boolean
  kind: 'result' | 'failure'
}

/** 工具门写回的风险动作用量（只在任务有动作时存在）。 */
export interface GrantUsage {
  job_id: string
  used: number
  max: number
  at: number
}

export interface ProactiveSnapshot {
  jobs: ProactiveJob[]
  inbox: InboxItem[]
  unread: number
  running_job: string | null
  grant_usage?: GrantUsage | null
}

/** 通知点击后的定位目标。 */
export interface FocusTarget {
  job_id: string
  inbox_id: string
}

/** 侧栏角标与收件箱页共用同一份未读数。 */
export const unreadCount = ref(0)

let listening = false

async function withSnapshot(p: Promise<ProactiveSnapshot>): Promise<ProactiveSnapshot> {
  const s = await p
  unreadCount.value = s.unread
  return s
}

/** 首次使用时挂监听；模块级布尔量保证全局只挂一次。 */
async function ensureListener() {
  if (listening || typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
  listening = true
  await listen('proactive://changed', () => {
    refreshUnread()
  })
}

export async function refreshUnread(): Promise<void> {
  const s = await invoke<ProactiveSnapshot>('proactive_snapshot').catch(() => null)
  if (s) unreadCount.value = s.unread
}

export function useProactive() {
  void ensureListener()

  const snapshot = () => withSnapshot(invoke<ProactiveSnapshot>('proactive_snapshot'))

  const createJob = (payload: {
    title: string
    prompt: string
    cwd: string
    interval_secs: number
  }) =>
    withSnapshot(
      invoke<ProactiveSnapshot>('proactive_job_create', {
        title: payload.title,
        prompt: payload.prompt,
        cwd: payload.cwd,
        interval_secs: payload.interval_secs,
      }),
    )

  const setEnabled = (id: string, enabled: boolean) =>
    withSnapshot(invoke<ProactiveSnapshot>('proactive_job_set_enabled', { id, enabled }))

  const removeJob = (id: string) =>
    withSnapshot(invoke<ProactiveSnapshot>('proactive_job_remove', { id }))

  const runNow = (id: string) =>
    withSnapshot(invoke<ProactiveSnapshot>('proactive_job_run_now', { id }))

  /** 只允许改 bash 前缀与风险动作额度；写入根由后端固定为项目目录。 */
  const setGrant = (id: string, bashAllow: string[], maxToolCalls: number) =>
    withSnapshot(
      invoke<ProactiveSnapshot>('proactive_job_set_grant', {
        id,
        bash_allow: bashAllow,
        max_tool_calls: maxToolCalls,
      }),
    )

  /** 通知发出后 90 秒内，应用获得焦点时取一次定位目标。 */
  const takeFocus = () => invoke<FocusTarget | null>('proactive_take_focus').catch(() => null)

  const markRead = (id: string, read: boolean) =>
    withSnapshot(invoke<ProactiveSnapshot>('proactive_inbox_mark', { id, read }))

  const markAllRead = () =>
    withSnapshot(invoke<ProactiveSnapshot>('proactive_inbox_mark_all_read'))

  return {
    snapshot,
    createJob,
    setEnabled,
    removeJob,
    runNow,
    setGrant,
    takeFocus,
    markRead,
    markAllRead,
  }
}
