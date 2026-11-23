import { describe, expect, it } from 'vitest'
import { buildPrompt, splitPromptBody, type PiAttachment, type PiQuote } from '@/composables/usePi'

/**
 * G4 会话持久化：journal 里的 user message 是**下发给内核的完整正文**
 * （dispatchToPi 会加 `preamble\n\n---\n\n` 前缀，buildPrompt 会追加引用/附件块）。
 * 回放展示必须还原成「用户原文 + 引用 + 附件」，否则气泡里露出大段项目上下文。
 * buildPrompt / splitPromptBody 是一对互逆运算， Round-trip 必须成立。
 */
describe('splitPromptBody', () => {
  it('无前缀无附件：原样返回', () => {
    expect(splitPromptBody('帮我改 foo.ts')).toEqual({
      text: '帮我改 foo.ts',
      attachments: [],
      quotes: [],
    })
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
    const atts: PiAttachment[] = [{ id: 'a1', name: 'a.png', kind: 'image', path: '/x/a.png' }]
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

describe('buildPrompt / splitPromptBody 引用块（#65）', () => {
  const quotes: PiQuote[] = [
    { id: 'q1', kind: 'text', text: '第一行\n第二行', note: '看这里' },
    { id: 'q2', kind: 'text', text: '普通的一句话' },
  ]

  it('引用块往返：多行原文与批注都无损', () => {
    const back = splitPromptBody(buildPrompt('接着分析', undefined, quotes))
    expect(back.text).toBe('接着分析')
    expect(back.quotes).toHaveLength(2)
    expect(back.quotes[0]).toMatchObject({ kind: 'text', text: '第一行\n第二行', note: '看这里' })
    expect(back.quotes[1]).toMatchObject({ kind: 'text', text: '普通的一句话' })
    expect(back.quotes[1].note).toBeUndefined()
  })

  it('反斜杠 + 字母 n 的陷阱：单遍解码才不把它当成换行', () => {
    // 'C:\new' 里是「反斜杠 + 字母 n」，顺序两次 replace 会误解放出换行。
    const tricky = '路径 C:\\new 结尾 \\'
    const back = splitPromptBody(buildPrompt('', undefined, [{ id: 'x', kind: 'text', text: tricky }]))
    expect(back.quotes[0].text).toBe(tricky)
  })

  it('引用 + 附件同轮：两块都剥掉、互不串台', () => {
    const atts: PiAttachment[] = [{ id: 'a1', name: 'a.png', kind: 'image', path: '/x/a.png' }]
    const back = splitPromptBody(buildPrompt('图文并参', atts, quotes))
    expect(back.text).toBe('图文并参')
    expect(back.attachments).toHaveLength(1)
    expect(back.quotes).toHaveLength(2)
  })

  it('只有引用、无正文：text 为空但引用保留（引用单独发送合法）', () => {
    const back = splitPromptBody(buildPrompt('', undefined, [quotes[1]]))
    expect(back.text).toBe('')
    expect(back.quotes).toHaveLength(1)
    expect(back.quotes[0].text).toBe('普通的一句话')
  })

  it('preamble + 引用：前缀与引用块都剥掉', () => {
    const body = `[项目上下文]\nx\n\n---\n\n${buildPrompt('带前缀', undefined, [quotes[0]])}`
    const back = splitPromptBody(body)
    expect(back.text).toBe('带前缀')
    expect(back.quotes[0].text).toBe('第一行\n第二行')
  })
})
