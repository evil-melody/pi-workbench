import { t } from '@/i18n'
import { fmtClock } from '@/utils/timeAgo'
import type { ConvMessage } from '@/composables/useConversationIO'

/**
 * 会话导出为可读文本（dsh 的 session log 口径，§5.3 收口）。
 *
 * 与 `serializeConversation`（迁移用 JSON）并列的第二种导出口径：给人读的
 * 逐轮纯文本转写，不是给机器往返的。规则照 dsh 的逐轮日志习惯：
 * - 头部一行元信息（导出时刻 + 条数），正文按消息到达顺序逐条；
 * - 每条 = 角色标签 + 时刻（`fmtClock` 缺 `at` 返回空串 → 整段时间隐藏，不编）+ 正文；
 * - 工具行（`tool` 字段）跟在正文后单独一行；
 * - 附件引用列在正文后（名称 + 路径），与 JSON 导出的路径引用同口径；
 * - 纯函数、不依赖 Tauri，可单测；文案全走 `t()`。
 */

/** 角色标签：`Pi` 是内核专名不译，其余走词典。 */
function roleLabel(role: ConvMessage['role']): string {
  if (role === 'user') return t('我')
  if (role === 'system') return t('系统')
  return 'Pi'
}

/** 正文缩进到标签下方，多行保持同一缩进列。 */
function indentBody(text: string): string {
  return text
    .split('\n')
    .map((l) => `  ${l}`)
    .join('\n')
}

/** 把会话消息摊成可读转写文本（UTF-8，落盘由调用方负责）。 */
export function formatConversationLog(
  messages: ConvMessage[],
  now: number = Date.now(),
): string {
  const head = fmtClock(now)
  const lines: string[] = [
    t('会话转写 · {0} · 共 {1} 条', [head, messages.length]),
    '',
  ]
  for (const m of messages) {
    const who = roleLabel(m.role)
    const at = m.at != null ? fmtClock(m.at, now) : ''
    lines.push(at ? `${who} · ${at}` : who)
    const body = m.text.trim()
    if (body) lines.push(indentBody(body))
    if (m.tool) lines.push(t('  ↳ 工具：{0}', [m.tool]))
    for (const a of m.attachments ?? []) {
      // key 必须含汉字（i18n 抽取器只认 \u4e00-\u9fff，全角符号不算）
      lines.push(t('  ↳ 附件 {0}：{1}（{2}）', [a.kind === 'image' ? t('图片') : t('文件'), a.name, a.path]))
    }
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}
