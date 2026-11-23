import { describe, expect, it } from 'vitest'
import { formatConversationLog } from '@/utils/conversationLog'
import type { ConvMessage } from '@/composables/useConversationIO'

/**
 * §5.3 收口：dsh session log 口径的可读转写。
 * 锁三件事：头行元信息、逐条「角色 + 时刻 + 正文」、缺数据段整段隐藏（不编时间）。
 * 形状：`头行 / 空行 / 每条（角色行 + 缩进正文 + 工具/附件行 + 空行）`，末尾单换行。
 */

const NOW = new Date(2026, 10, 23, 14, 30).getTime()

describe('formatConversationLog · 可读转写', () => {
  it('头行带条数元信息，正文按顺序逐条', () => {
    const msgs: ConvMessage[] = [
      { id: 'u1', role: 'user', text: '把 README 补全' },
      { id: 'a1', role: 'assistant', text: '已更新 README', tool: 'edit' },
    ]
    const out = formatConversationLog(msgs, NOW)
    const lines = out.split('\n')
    expect(lines[0]).toContain('共 2 条')
    expect(out).toContain('我\n  把 README 补全')
    expect(out).toContain('Pi\n  已更新 README\n  ↳ 工具：edit')
  })

  it('缺 at 的消息不画时间（数据诚实，与 .ta-clock 同口径）', () => {
    const out = formatConversationLog([{ id: 'u1', role: 'user', text: 'hi' }], NOW)
    expect(out).toBe('会话转写 · 14:30 · 共 1 条\n\n我\n  hi\n')
  })

  it('有 at 的角色行带时刻（同日 HH:mm）', () => {
    const at = new Date(2026, 10, 23, 9, 5).getTime()
    const out = formatConversationLog([{ id: 'u1', role: 'user', text: 'hi', at }], NOW)
    expect(out.split('\n')[2]).toBe('我 · 09:05')
  })

  it('附件引用逐行列出（名称 + 路径），与 JSON 导出口径一致', () => {
    const out = formatConversationLog(
      [
        {
          id: 'u1',
          role: 'user',
          text: '看这张图',
          attachments: [{ id: 'x', name: 'shot.png', kind: 'image', path: '/cfg/shot.png' }],
        },
      ],
      NOW,
    )
    expect(out).toContain('图片：shot.png（/cfg/shot.png）')
  })

  it('多行正文整体缩进，不顶格拆行', () => {
    const out = formatConversationLog([{ id: 'a1', role: 'assistant', text: '第一行\n第二行' }], NOW)
    expect(out).toContain('  第一行\n  第二行')
  })

  it('空会话只剩头行，不产出孤条', () => {
    const out = formatConversationLog([], NOW)
    expect(out).toBe('会话转写 · 14:30 · 共 0 条\n')
  })

  it('系统消息落「系统」标签', () => {
    const out = formatConversationLog([{ id: 's1', role: 'system', text: '内核重启' }], NOW)
    expect(out).toContain('系统\n  内核重启')
  })
})
