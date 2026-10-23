import { describe, expect, it } from 'vitest'
import {
  buildRunShareText,
  fmtRunClock,
  fmtRunDuration,
  fmtRunTimeRange,
} from '@/utils/runShare'

/**
 * 分享摘要拼装：全部纯函数，用本地日历构造固定时间戳
 * （Date 组件 getter 与 fmtRunClock 同一时区，断言不漂移）。
 */
describe('buildRunShareText', () => {
  const start = new Date(2024, 0, 2, 10, 0).getTime()
  const end = new Date(2024, 0, 2, 11, 30).getTime()
  const base = { title: '修复登录页样式', startedAtMs: start, endedAtMs: end, prompts: 3, cwd: '/repo/a' }

  it('markdown 摘要包含标题 / 起止时间 / 轮数 / 任务数 / cwd', () => {
    const text = buildRunShareText(base)
    expect(text).toContain('# 修复登录页样式')
    expect(text).toContain('- 起止时间：2024-01-02 10:00 ~ 2024-01-02 11:30（约 1 小时 30 分钟）')
    expect(text).toContain('- 轮数：3 轮')
    expect(text).toContain('- 任务数：3')
    expect(text).toContain('- 工作目录：`/repo/a`')
  })

  it('标题为空时兜底为「（未命名运行记录）」', () => {
    expect(buildRunShareText({ ...base, title: '   ' })).toContain('# （未命名运行记录）')
  })

  it('零轮次如实写 0（不为美化抹掉）', () => {
    const text = buildRunShareText({ ...base, prompts: 0 })
    expect(text).toContain('- 轮数：0 轮')
    expect(text).toContain('- 任务数：0')
  })

  it('起止时间缺失时降级，不编时间', () => {
    expect(buildRunShareText({ ...base, startedAtMs: null, endedAtMs: null })).toContain(
      '- 起止时间：时间未知',
    )
    const onlyStart = buildRunShareText({ ...base, endedAtMs: null })
    expect(onlyStart).toContain('- 起止时间：开始于 2024-01-02 10:00')
    expect(onlyStart).not.toContain('~')
  })
})

describe('fmtRunDuration', () => {
  it('按量级给出中文概览', () => {
    expect(fmtRunDuration(30_000)).toBe('不到 1 分钟')
    expect(fmtRunDuration(45 * 60_000)).toBe('45 分钟')
    expect(fmtRunDuration(2 * 3_600_000)).toBe('2 小时')
    expect(fmtRunDuration(90 * 60_000)).toBe('1 小时 30 分钟')
    expect(fmtRunDuration(25 * 3_600_000)).toBe('1 天 1 小时')
    expect(fmtRunDuration(2 * 86_400_000)).toBe('2 天')
  })

  it('非正数 / 非有限值返回空串', () => {
    expect(fmtRunDuration(0)).toBe('')
    expect(fmtRunDuration(-1)).toBe('')
    expect(fmtRunDuration(Number.NaN)).toBe('')
    expect(fmtRunDuration(Number.POSITIVE_INFINITY)).toBe('')
  })
})

describe('fmtRunClock / fmtRunTimeRange', () => {
  const ms = new Date(2024, 0, 2, 9, 5).getTime()

  it('本地时间格式化为 YYYY-MM-DD HH:mm', () => {
    expect(fmtRunClock(ms)).toBe('2024-01-02 09:05')
  })

  it('空值 / 非法值返回空串', () => {
    expect(fmtRunClock(null)).toBe('')
    expect(fmtRunClock(undefined)).toBe('')
    expect(fmtRunClock(0)).toBe('')
    expect(fmtRunClock(Number.NaN)).toBe('')
  })

  it('只有结束时间时写「结束于」', () => {
    expect(fmtRunTimeRange(null, ms)).toBe('结束于 2024-01-02 09:05')
  })

  it('两端都有但时长为 0 时不附「约」', () => {
    expect(fmtRunTimeRange(ms, ms)).toBe('2024-01-02 09:05 ~ 2024-01-02 09:05')
  })
})
