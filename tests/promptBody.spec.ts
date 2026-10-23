import { describe, expect, it } from 'vitest'
import { buildPrompt, splitPromptBody, type PiAttachment } from '@/composables/usePi'

/**
 * G4 会话持久化：journal 里的 user message 是**下发给内核的完整正文**
 * （dispatchToPi 会加 `preamble\n\n---\n\n` 前缀，buildPrompt 会追加附件块）。
 * 回放展示必须还原成「用户原文 + 附件」，否则气泡里露出大段项目上下文。
 * buildPrompt / splitPromptBody 是一对互逆运算， Round-trip 必须成立。
 */
describe('splitPromptBody', () => {
  it('无前缀无附件：原样返回', () => {
    expect(splitPromptBody('帮我改 foo.ts')).toEqual({ text: '帮我改 foo.ts', attachments: [] })
  })

  it('剥掉 dispatchToPi 的 preamble 前缀', () => {
    const body = '[项目上下文]\nxxx\n\n---\n\n帮我改 foo.ts'
    expect(splitPromptBody(body).text).toBe('帮我改 foo.ts')
  })

  it('还原附件块（image / file 两类）', () => {
    const atts: PiAttachment[] = [
      { id: 'a1', name: 'shot.png', kind: 'image', path: '/cfg/attachments/shot.png' },
      { id: 'a2', name: 'spec.pdf', kind: 'file', path: '/cfg/attachments/spec.pdf' },
    ]
    const body = buildPrompt('看看这个', atts)
    const back = splitPromptBody(body)
    expect(back.text).toBe('看看这个')
    expect(back.attachments).toHaveLength(2)
    expect(back.attachments[0]).toMatchObject({ kind: 'image', path: '/cfg/attachments/shot.png' })
    expect(back.attachments[1]).toMatchObject({ kind: 'file', path: '/cfg/attachments/spec.pdf' })
    expect(back.attachments[0].name).toBe('shot.png')
  })

  it('preamble + 附件同时存在：两项都剥掉', () => {
    const atts: PiAttachment[] = [
      { id: 'a1', name: 'a.png', kind: 'image', path: '/x/a.png' },
    ]
    const body = `[项目上下文]\n一堆上下文\n\n---\n\n${buildPrompt('分析这张图', atts)}`
    const back = splitPromptBody(body)
    expect(back.text).toBe('分析这张图')
    expect(back.attachments).toHaveLength(1)
    expect(back.attachments[0].path).toBe('/x/a.png')
  })

  it('正文里含 "---" 但非分隔符：不误伤', () => {
    // 分隔符是完整的 "\n\n---\n\n"；正文中间的短横线不能触发切割。
    expect(splitPromptBody('a --- b').text).toBe('a --- b')
  })

  it('附件块后面还有别的内容：只取附件块之前为正文', () => {
    const body = '原文\n\n[附件 / attachments]\n- file: /x/a.ts'
    const back = splitPromptBody(body)
    expect(back.text).toBe('原文')
    expect(back.attachments[0].path).toBe('/x/a.ts')
  })
})
