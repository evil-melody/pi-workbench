import { describe, expect, it } from 'vitest'
import { buildPrompt, type PiAttachment } from '../src/composables/usePi'

const atts: PiAttachment[] = [
  { id: 'a1', name: 'shot.png', kind: 'image', path: '/cfg/attachments/shot.png' },
  { id: 'a2', name: 'log.txt', kind: 'file', path: '/cfg/attachments/log.txt' },
]

describe('buildPrompt（多模态路径引用绕行）', () => {
  it('无附件时原样返回文本', () => {
    expect(buildPrompt('hello')).toBe('hello')
    expect(buildPrompt('hello', [])).toBe('hello')
    expect(buildPrompt('hello', undefined)).toBe('hello')
  })

  it('有附件时追加「路径引用块」，message 仍为纯字符串', () => {
    const out = buildPrompt('分析截图', atts)
    expect(typeof out).toBe('string')
    expect(out).toContain('分析截图')
    expect(out).toContain('[附件 / attachments]')
    expect(out).toContain('- image: /cfg/attachments/shot.png')
    expect(out).toContain('- file: /cfg/attachments/log.txt')
  })

  it('纯字符串约束：不产出 content block 对象（Pi RPC 只接受字符串）', () => {
    const out = buildPrompt('看图', atts)
    expect(() => JSON.parse(out)).toThrow() // 不是结构化 content 数组
    expect(out).not.toContain('image_url')
  })
})
