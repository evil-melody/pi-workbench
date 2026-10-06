import { describe, expect, it } from 'vitest'
import {
  serializeConversation,
  deserializeConversation,
  type ConvMessage,
} from '../src/composables/useConversationIO'

const sample: ConvMessage[] = [
  { id: 'u1', role: 'user', text: '把项目说明补全' },
  { id: 'a1', role: 'assistant', text: '已更新 README', tool: 'edit' },
  { id: 's1', role: 'system', text: 'system note' },
]

describe('会话序列化 / 反序列化', () => {
  it('往返一致：导出再导入拿回同样内容', () => {
    const file = serializeConversation(sample)
    expect(file.format).toBe('pi-workbench-conversation')
    expect(file.version).toBe(1)
    expect(Array.isArray(file.messages)).toBe(true)

    const back = deserializeConversation(file)
    expect(back).toEqual(sample)
  })

  it('只保留声明字段，不泄漏运行时态', () => {
    const file = serializeConversation(sample)
    const raw = JSON.parse(JSON.stringify(file))
    expect(raw.messages[0]).not.toHaveProperty('usage')
    expect(raw.messages[1]).not.toHaveProperty('streaming')
  })

  it('拒绝非本格式文件', () => {
    expect(() => deserializeConversation({ format: 'other', messages: [] })).toThrow(/格式不匹配/)
  })

  it('拒绝缺 messages 数组', () => {
    expect(() => deserializeConversation({ format: 'pi-workbench-conversation' })).toThrow(
      /messages/,
    )
  })

  it('拒绝单条消息字段非法', () => {
    const bad = serializeConversation(sample)
    // @ts-expect-error 故意破坏
    bad.messages[0].role = ' alien'
    expect(() => deserializeConversation(bad)).toThrow(/第 1 条/)
  })

  it('缺失 id / at 时补默认值不报错', () => {
    const file = { format: 'pi-workbench-conversation', version: 1, exportedAt: '', messages: [{ role: 'user', text: 'hi' }] }
    const back = deserializeConversation(file)
    expect(back[0].id).toBeTruthy()
    expect(back[0].text).toBe('hi')
  })

  it('附件引用随会话往返一致（路径引用不丢）', () => {
    const withAtt: ConvMessage[] = [
      {
        id: 'u1',
        role: 'user',
        text: '分析这张截图',
        attachments: [
          { id: 'att1', name: 'shot.png', kind: 'image', path: '/cfg/attachments/shot.png' },
          { id: 'att2', name: 'log.txt', kind: 'file', path: '/cfg/attachments/log.txt' },
        ],
      },
    ]
    const back = deserializeConversation(serializeConversation(withAtt))
    expect(back[0].attachments).toEqual(withAtt[0].attachments)
  })

  it('附件字段非法时抛错', () => {
    const file = {
      format: 'pi-workbench-conversation',
      version: 1,
      exportedAt: '',
      messages: [
        {
          role: 'user',
          text: 'x',
          attachments: [{ id: 'a', name: 'n', kind: 'video', path: '/p' }],
        },
      ],
    }
    expect(() => deserializeConversation(file)).toThrow(/附件 1/)
  })

  it('空附件数组序列化后不落盘到文件', () => {
    const withEmpty: ConvMessage[] = [{ id: 'u1', role: 'user', text: 'hi', attachments: [] }]
    const raw = JSON.parse(JSON.stringify(serializeConversation(withEmpty)))
    expect(raw.messages[0]).not.toHaveProperty('attachments')
  })
})
