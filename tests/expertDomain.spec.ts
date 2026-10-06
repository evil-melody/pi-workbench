import { describe, expect, it } from 'vitest'
import {
  describeExpertError,
  estimateTokens,
  emptyDefinition,
  groupIssues,
  issuesFor,
  type DomainIssue,
  type ExpertDefinition,
} from '@/composables/useExperts'

/** 与 Rust 侧 estimate_instruction_tokens 同一套口径：ASCII 4 字符 1 token，非 ASCII 1 字符 1 token。 */
describe('指令 token 估算与后端口径对齐', () => {
  it('ASCII 每 4 个字符折算 1 个 token', () => {
    expect(estimateTokens('aaaa')).toBe(1)
    expect(estimateTokens('aaaaaaaa')).toBe(2)
    expect(estimateTokens('abcdefghij')).toBe(3)
  })

  it('非 ASCII 每字符折算 1 个 token', () => {
    expect(estimateTokens('专家')).toBe(2)
    expect(estimateTokens('项目配置修订')).toBe(6)
  })

  it('混合文本按字符逐个判断，不做整串猜测', () => {
    // 4 个 ASCII 折 1 token + 2 个汉字折 2 token = 3。
    expect(estimateTokens('ab中文cd')).toBe(3)
  })
})

describe('发布错误码翻译', () => {
  const cases: Array<[string, string]> = [
    ['experts/confirmation-required', '还需要你确认一次发布授权'],
    ['experts/confirmation-stale', '授权已过期或内容已变更，请重新确认'],
    ['experts/revision-conflict', '这份草稿已被改过，请刷新后重试'],
    ['experts/invalid-definition', '定义尚未通过校验，不能发布'],
    ['experts/draft-not-found', '草稿不存在，请先保存再发布'],
    ['experts/draft-unreadable', '草稿读取失败，可能被外部改坏了'],
  ]

  for (const [code, text] of cases) {
    it(`${code} → ${text}`, () => {
      expect(describeExpertError({ message: `invoke failed: ${code}` })).toBe(text)
    })
  }

  it('未知错误回退到兜底文案', () => {
    expect(describeExpertError(new Error('boom'), '操作失败')).toBe('操作失败')
    expect(describeExpertError(new Error('boom'))).toBe('操作失败')
  })
})

describe('校验问题归组', () => {
  const issues: DomainIssue[] = [
    { code: 'definition/required', path: 'name', message: '名称不能为空。' },
    { code: 'definition/required', path: 'role', message: '角色定位不能为空。' },
    { code: 'definition/template-braces', path: 'role', message: '不能包含 {{ 。' },
    { code: 'definition/too-large', path: undefined, message: '定义过大。' },
  ]

  it('按 path 归组，没有 path 的按 code 归组', () => {
    const grouped = groupIssues(issues)
    expect(Object.keys(grouped).sort()).toEqual(['definition/too-large', 'name', 'role'])
    expect(grouped.role).toHaveLength(2)
  })

  it('issuesFor 只取该字段的问题', () => {
    expect(issuesFor(issues, 'role').map((i) => i.code)).toEqual([
      'definition/required',
      'definition/template-braces',
    ])
    expect(issuesFor(issues, 'methodology')).toEqual([])
  })
})

describe('空定义', () => {
  it('九个字段齐备，数组字段留空', () => {
    const d: ExpertDefinition = emptyDefinition()
    expect(Object.keys(d).sort()).toEqual(
      [
        'boundaries',
        'deliverables',
        'description',
        'examples',
        'methodology',
        'name',
        'role',
        'skill_requirements',
        'tags',
      ].sort(),
    )
    expect(d.tags).toEqual([])
    expect(d.examples).toEqual([])
    expect(d.skill_requirements).toEqual([])
  })
})
