import { describe, expect, it } from 'vitest'
import { extractMemoryCandidates, dedupeCandidates } from '@/composables/useMemoryExtract'

/**
 * 记忆抽取守的是「宁缺毋滥」：只认显式信号词，绝不给用户塞一堆错误记忆。
 * 对齐 Hindsight 的 retain 思想但不引入 LLM：规则抽取 + 类型标签。
 */
describe('对话记忆抽取', () => {
  it('偏好与禁忌信号词抽成 preference 类型', () => {
    const out = extractMemoryCandidates('我偏好电报体汇报。不要用大段废话。')
    expect(out.length).toBe(2)
    expect(out.every((c) => c.tags.includes('preference'))).toBe(true)
    expect(out.every((c) => c.tags.includes('dialogue-extract'))).toBe(true)
  })

  it('「记住」抽成 world 事实并去掉前缀', () => {
    const out = extractMemoryCandidates('记住：所有 API 都用 v2 版本')
    expect(out).toEqual([{ text: '所有 API 都用 v2 版本', tags: ['world', 'dialogue-extract'] }])
  })

  it('一次性任务、询问、短句一律不抽', () => {
    expect(extractMemoryCandidates('这次先帮我改一下按钮')).toEqual([])
    expect(extractMemoryCandidates('为什么构建失败？')).toEqual([])
    expect(extractMemoryCandidates('记住')).toEqual([])
  })

  it('与已有记忆重复的文本不再写入', () => {
    const candidates = extractMemoryCandidates('我偏好电报体汇报。')
    expect(dedupeCandidates(candidates, ['我偏好电报体汇报'])).toEqual([])
  })

  it('同批候选之间也去重', () => {
    const candidates = [
      { text: '同样的话', tags: ['world'] },
      { text: '同样的话', tags: ['preference'] },
    ]
    expect(dedupeCandidates(candidates, []).length).toBe(1)
  })
})
