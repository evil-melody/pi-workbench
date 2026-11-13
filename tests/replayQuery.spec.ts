import { beforeEach, describe, expect, it, vi } from 'vitest'
import { listRunHistory, parseReplayQuery } from '@/composables/useReplay'

// listRunHistory 走 Tauri IPC：桩成桌面模式 + mock invoke（同 runHistory.spec.ts 的做法）。
const invokeMock = vi.hoisted(() => vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@/composables/usePi', () => ({
  IN_TAURI: true,
  splitPromptBody: (s: string) => ({ text: s }),
}))

/**
 * 独立回放窗口的 query 解析（后端 open_replay_window 用
 * `#/chat?replay=<段号>&cwd=<目录>` 拉起新窗口）。纯函数，可单测。
 */
describe('parseReplayQuery', () => {
  it('合法段号 → 目标（cwd 缺省为空串）', () => {
    expect(parseReplayQuery({ replay: '3' })).toEqual({ index: 3, cwd: '' })
    expect(parseReplayQuery({ replay: 0 })).toEqual({ index: 0, cwd: '' })
    expect(parseReplayQuery({ replay: '2', cwd: '/repo/a' })).toEqual({ index: 2, cwd: '/repo/a' })
  })

  it('cwd 非字符串时回落空串（调用方用活动项目目录兜底）', () => {
    expect(parseReplayQuery({ replay: '2', cwd: 5 })).toEqual({ index: 2, cwd: '' })
  })

  it('段号非法 / 缺失 → null（按普通页面处理，不误触发回放）', () => {
    expect(parseReplayQuery({ replay: 'abc' })).toBeNull()
    expect(parseReplayQuery({ replay: '3.5' })).toBeNull()
    expect(parseReplayQuery({ replay: '-1' })).toBeNull()
    expect(parseReplayQuery({ replay: '' })).toBeNull()
    expect(parseReplayQuery({})).toBeNull()
    expect(parseReplayQuery(undefined)).toBeNull()
    expect(parseReplayQuery(null)).toBeNull()
  })
})

/**
 * 左栏运行记录排序（用户要求「最新的放顶部，历史越久越靠后」）。
 * 回归点：此前前端在后端已排好序的结果上又多做一次 `.reverse()`，
 * 整列被翻成「旧→新」，长会话还会因段号 vs 结束时间错位。
 */
const HOUR = 3_600_000
const T0 = 1_700_000_000_000

/** 造一段 journal 段（后端返回的是 snake_case）。 */
function seg(s: Record<string, unknown>) {
  return {
    index: 0,
    cwd: '/repo/a',
    started_at_ms: T0,
    ended_at_ms: T0 + HOUR,
    events: 10,
    prompts: 1,
    title: 't',
    ...s,
  }
}

describe('listRunHistory 排序', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  it('按结束时间倒序（最新在顶），置顶段仍排最前', async () => {
    invokeMock.mockResolvedValue([
      seg({ index: 0, title: '昨天的长会话', started_at_ms: T0 - 24 * HOUR, ended_at_ms: T0 - 20 * HOUR }),
      seg({ index: 1, title: '刚结束', started_at_ms: T0 - 2 * HOUR, ended_at_ms: T0 }),
      seg({ index: 2, title: '置顶的旧的', started_at_ms: T0 - 5 * HOUR, ended_at_ms: T0 - 4 * HOUR, pinned: true }),
    ])
    const list = await listRunHistory()
    expect(list.map((r) => r.title)).toEqual(['置顶的旧的', '刚结束', '昨天的长会话'])
  })

  it('段号大但更早结束的段排在后面（排序键是时间不是段号）', async () => {
    invokeMock.mockResolvedValue([
      seg({ index: 7, started_at_ms: T0 - 10 * HOUR, ended_at_ms: T0 - 9 * HOUR, title: '旧' }),
      seg({ index: 8, started_at_ms: T0 - 3 * HOUR, ended_at_ms: T0 - HOUR, title: '新' }),
    ])
    expect((await listRunHistory()).map((r) => r.title)).toEqual(['新', '旧'])
  })

  it('双方都没有时间戳时按段号倒序兜底（不再整体 reverse 后端结果）', async () => {
    invokeMock.mockResolvedValue([
      seg({ index: 0, started_at_ms: null, ended_at_ms: null, title: 'a' }),
      seg({ index: 1, started_at_ms: null, ended_at_ms: null, title: 'b' }),
      seg({ index: 2, started_at_ms: null, ended_at_ms: null, title: 'c' }),
    ])
    expect((await listRunHistory()).map((r) => r.index)).toEqual([2, 1, 0])
  })

  it('零任务段与非整数段号被过滤；cwd 只列本项目段', async () => {
    invokeMock.mockResolvedValue([
      seg({ index: 1, prompts: 2 }),
      seg({ index: 2, prompts: 0, title: '内核自启' }),
      seg({ index: 1.5, prompts: 1 }),
      seg({ index: 3, cwd: '/repo/b', prompts: 4 }),
    ])
    // 默认时间戳相同 → 退回段号倒序，所以 3 在 1 前
    expect((await listRunHistory()).map((r) => r.index)).toEqual([3, 1])
    expect((await listRunHistory('/repo/a')).map((r) => r.index)).toEqual([1])
  })

  it('includeArchived 透传给后端', async () => {
    invokeMock.mockResolvedValue([])
    await listRunHistory('/repo/a', true)
    expect(invokeMock).toHaveBeenCalledWith('pi_journal_sessions', { include_archived: true })
  })

  it('后端失败 → 空数组（列表整体隐藏，不报错打扰）', async () => {
    invokeMock.mockRejectedValue(new Error('boom'))
    await expect(listRunHistory()).resolves.toEqual([])
  })
})
