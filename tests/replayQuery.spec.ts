import { describe, expect, it } from 'vitest'
import { parseReplayQuery } from '@/composables/useReplay'

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
