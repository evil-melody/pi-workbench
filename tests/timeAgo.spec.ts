import { describe, expect, it } from 'vitest'
import { timeAgo } from '@/utils/timeAgo'

/** 固定「现在」：2026-10-18 12:00:00 UTC+8。 */
const NOW = Date.UTC(2026, 9, 18, 4, 0, 0)

describe('timeAgo', () => {
  it('分钟级：刚刚 / N分钟前', () => {
    expect(timeAgo(NOW - 0, NOW)).toBe('刚刚')
    expect(timeAgo(NOW - 59_000, NOW)).toBe('刚刚')
    expect(timeAgo(NOW - 5 * 60_000, NOW)).toBe('5分钟前')
    expect(timeAgo(NOW - 59 * 60_000, NOW)).toBe('59分钟前')
  })

  it('小时级 / 天级', () => {
    expect(timeAgo(NOW - 11 * 3_600_000, NOW)).toBe('11小时前')
    expect(timeAgo(NOW - 23 * 3_600_000, NOW)).toBe('23小时前')
    expect(timeAgo(NOW - 2 * 86_400_000, NOW)).toBe('2天前')
    expect(timeAgo(NOW - 29 * 86_400_000, NOW)).toBe('29天前')
  })

  it('月级 / 年级', () => {
    expect(timeAgo(NOW - 60 * 86_400_000, NOW)).toBe('2个月前')
    expect(timeAgo(NOW - 400 * 86_400_000, NOW)).toBe('1年前')
  })

  it('脏值：null / 0 / 负数 / NaN 给空串或刚刚', () => {
    expect(timeAgo(null, NOW)).toBe('')
    expect(timeAgo(0, NOW)).toBe('')
    expect(timeAgo(NaN, NOW)).toBe('')
    expect(timeAgo(NOW + 5_000, NOW)).toBe('刚刚')
  })
})
