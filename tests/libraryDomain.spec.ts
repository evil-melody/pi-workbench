import { describe, expect, it } from 'vitest'
import {
  CONVERT_TEXT,
  KIND_TEXT,
  ORIGIN_TEXT,
  describeLibraryError,
  formatBytes,
  formatTime,
} from '@/composables/useLibrary'

/**
 * 前端这层要守住的不是「调用有没有写对」，而是**后端返回的东西有没有被界面正确表达**。
 * 具体三条：
 *   1. 后端抛的错误码必须落到人话上，认不得也不能把 `library/xxx` 甩给用户；
 *   2. 文案表必须覆盖后端会发出的每一种取值，否则界面直接显示 undefined；
 *   3. 字节与时间的格式化得能往返，不然配额条会算出 > 100% 的宽度。
 */

describe('错误码到人话', () => {
  it('停用禁止读取这条语义必须有文案', () => {
    expect(describeLibraryError('library/disabled: 报告.md')).toBe(
      '该资料已停用，启用后才能读取正文',
    )
  })

  it('五条不可打折扣的语义各自对应一个错误码', () => {
    const cases: [string, string][] = [
      ['library/not-found', '资料不存在，可能已被删除'],
      ['library/already-registered', '同一位置已经有同名资料了'],
      ['library/path-taken', '目标位置已存在同名文件'],
      ['library/file-too-large', '文件超过 50 MiB 上限'],
      ['library/quotas-exceeded', '超过资料库 5 GiB 合计上限'],
    ]
    for (const [code, text] of cases) expect(describeLibraryError(code)).toBe(text)
  })

  it('认不得的错误码回退到兜底文案，而不是把后端原文抛出去', () => {
    expect(describeLibraryError('library/whatever', '操作失败')).toBe('操作失败')
    expect(describeLibraryError(new Error('library/not-found'))).toBe('资料不存在，可能已被删除')
    expect(describeLibraryError('')).toBe('操作失败')
    expect(describeLibraryError(undefined)).toBe('操作失败')
  })
})

describe('文案表覆盖后端会发出的取值', () => {
  it('来源文案覆盖 AssetOrigin.kind 的五种取值', () => {
    // Rust 侧 AssetOrigin::kind ∈ created / imported / written / draft-published / rollback
    expect(Object.keys(ORIGIN_TEXT).sort()).toEqual(
      ['created', 'draft-published', 'imported', 'rollback', 'written'].sort(),
    )
  })

  it('类型文案覆盖 AssetKind 的七种取值', () => {
    expect(Object.keys(KIND_TEXT).sort()).toEqual(
      ['docx', 'html', 'markdown', 'other', 'pdf', 'pptx', 'text'].sort(),
    )
  })

  it('转换状态文案覆盖 library_search 的三种取值', () => {
    // Rust 侧 convert_status ∈ ready / failed / skipped
    expect(Object.keys(CONVERT_TEXT).sort()).toEqual(['failed', 'ready', 'skipped'])
  })
})

describe('格式化', () => {
  it('字节按 1024 进制换算并选对单位', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(1024)).toBe('1.0 KiB')
    expect(formatBytes(50 * 1024 * 1024)).toBe('50.00 MiB')
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.00 GiB')
  })

  it('零值是占位符而不是 1970 年', () => {
    expect(formatTime(0)).toBe('—')
  })

  it('时间输出固定为「月-日 时:分」，不带年份，避免占宽度', () => {
    const ms = new Date(2026, 8, 27, 14, 5).getTime()
    expect(formatTime(ms)).toBe('09-27 14:05')
  })
})
