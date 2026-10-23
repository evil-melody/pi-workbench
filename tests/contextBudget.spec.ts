import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PREAMBLE_BUDGET_TOKENS,
  estimateTokens,
  trimPreamble,
} from '@/composables/contextBudget'

describe('contextBudget (B4 上下文预算)', () => {
  it('estimateTokens: CJK 密度高于拉丁', () => {
    const cjk = estimateTokens('四个汉字测试')
    const latin = estimateTokens('aaaa') // 4 拉丁字符 ≈ 1 token
    expect(cjk).toBeGreaterThan(2) // 6 CJK 字 ≈ 4.5 tokens
    expect(latin).toBeLessThanOrEqual(2)
    // 空串为 0
    expect(estimateTokens('')).toBe(0)
  })

  it('预算内不裁剪', () => {
    const p = '[项目] demo\n[配置修订 #1]\n简短指令\n[本次引用] A、B'
    const r = trimPreamble(p, DEFAULT_PREAMBLE_BUDGET_TOKENS)
    expect(r.trimmed).toBe(false)
    expect(r.preamble).toBe(p)
    expect(r.finalTokens).toBe(r.originalTokens)
  })

  it('超预算：低优先级行先丢（引用先于指令），并显式标注已裁剪', () => {
    const longRefs = `[本次引用] ${'引用项、'.repeat(600)}` // ≈2400 CJK 字 ≈ 1800 tokens
    const longCaps = `[本次可用能力] ${'能力项、'.repeat(600)}`
    const instruction = '这是核心指令'.repeat(50) // ≈300 tokens
    const p = [
      '[项目] demo',
      '[配置修订 #1]',
      instruction,
      longCaps,
      longRefs,
    ].join('\n')
    const budget = 500
    const r = trimPreamble(p, budget)
    expect(r.trimmed).toBe(true)
    expect(r.finalTokens).toBeLessThanOrEqual(budget + 60) // 标注行本身占一点
    expect(r.preamble).toContain('[项目] demo')
    expect(r.preamble).toContain('这是核心指令')
    expect(r.preamble).toContain('[已裁剪]')
    // 引用比能力先丢：裁掉的内容里应有引用；能力视预算可能保留或被裁
    expect(r.preamble).not.toContain('引用项')
  })

  it('极端：预算小到只剩元信息行也不空手', () => {
    const p = '[项目] demo\n[配置修订 #1]\n指令正文'
    const r = trimPreamble(p, 1)
    expect(r.preamble).toContain('[项目] demo')
    expect(r.trimmed).toBe(true)
  })

  it('单行超限被 clampLine 截断', () => {
    const p = `[项目] demo\n${'长'.repeat(5000)}`
    const r = trimPreamble(p, DEFAULT_PREAMBLE_BUDGET_TOKENS)
    expect(r.preamble).toContain('单行超限已截断')
  })

  it('空前缀安全', () => {
    const r = trimPreamble('')
    expect(r.trimmed).toBe(false)
    expect(r.preamble).toBe('')
  })
})
