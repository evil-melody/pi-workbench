/**
 * M5 推荐源：本轮落定前，按最后一条用户 prompt 生成三条延续问题，
 * 经 `pi.appendEntry('pi_suggest', …)` 落进 journal → 桥转发 entry_appended
 * → 前端 composer 上方 chip（填入不自动发 / 换一条 / 关闭）。
 *
 * 口径：模板源，不调模型。扩展 API 无生成通道（ExtensionAPI 类型实证），
 * 且推荐是「顺着刚才的话往下问」——模板足够，模型调用反而拖慢收尾。
 * 只在文本非空且本轮不是纯错误时产；同一段文本重复落定不重复写。
 */

/** 前端约定的 customType，与 piEvents / stub 同源。 */
export const SUGGEST_CUSTOM_TYPE = 'pi_suggest'

/** 三条模板槽位：继续 / 验证 / 换角度。topic 为从用户文本抽出的主题短语。 */
const TEMPLATES = [
  (topic: string) => `继续${topic}，把剩下部分做完`,
  (topic: string) => `给${topic}补上测试和边界处理`,
  (topic: string) => `换个角度检查${topic}有没有更简单的做法`,
]

/**
 * 从 prompt 文本抽主题短语（纯函数，可单测）。
 * 先剥掉派遣指令头与 preamble（它们不是用户问题：截图里曾推出
 * 「继续You are the team lead...」）；再去代码块/标记块/空白，截到 24 字。
 */
export function topicFrom(text: string): string | null {
  if (typeof text !== 'string') return null
  const taskMark = '\n--- USER TASK ---\n'
  let raw = text
  const at = raw.indexOf(taskMark)
  if (at >= 0) raw = raw.slice(at + taskMark.length)
  const preamble = '\n\n---\n\n'
  const sep = raw.indexOf(preamble)
  if (sep >= 0) raw = raw.slice(sep + preamble.length)
  const clean = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return null
  const short = clean.length > 24 ? `${clean.slice(0, 24)}…` : clean
  return short
}

/** 产三条推荐（纯函数）；topic 抽不到返回空数组。 */
export function suggestFrom(text: string): string[] {
  const topic = topicFrom(text)
  if (!topic) return []
  return TEMPLATES.map((fn) => fn(topic))
}

/** 从 llmMessages 里倒着找最后一条 user 的纯文本。 */
function lastUserText(msgs: unknown): string | null {
  if (!Array.isArray(msgs)) return null
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as { role?: unknown; content?: unknown }
    if (m?.role !== 'user') continue
    const c = m.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      const parts = c
        .map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : ''))
        .filter(Boolean)
      if (parts.length) return parts.join(' ')
    }
  }
  return null
}

export default function (pi: any) {
  let lastFingerprint = ''
  pi.on('agent_before_settle', (event: any) => {
    try {
      // 只在正常完成时产推荐：出错/中断的轮次推「继续做」只会添乱。
      if (event?.outcome && event.outcome !== 'completed') return
      const msgs = event?.context?.llmMessages ?? event?.context?.contextMessages
      const text = lastUserText(msgs)
      const suggestions = suggestFrom(text ?? '')
      if (!suggestions.length) return
      // 同一段文本重复落定（自动重试/重放）不重复写条目。
      const fingerprint = suggestions.join('\n')
      if (fingerprint === lastFingerprint) return
      lastFingerprint = fingerprint
      pi.appendEntry(SUGGEST_CUSTOM_TYPE, { suggestions })
    } catch {
      /* 推荐是锦上添花：任何异常静默跳过，绝不拦收尾 */
    }
  })
}
