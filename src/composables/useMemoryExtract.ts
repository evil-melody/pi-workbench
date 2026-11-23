/**
 * 从用户对话里筛选值得长期记住的事实（Hindsight retain 的轻量本地版）。
 *
 * 设计取舍：Hindsight（vectorize-io/hindsight, MIT, arXiv 2512.12818）用 LLM
 * 做 retain 抽取 + observation 合并；本仓不引入 Python/Postgres/新 LLM 通道，
 * 改为「明确信号词规则抽取 + 已有 tags 承载类型」，落到既有 memory.jsonl：
 *   - world        客观事实（项目约定、技术栈）
 *   - preference   用户偏好 / 禁忌 / 目标
 *   - experience   助手做过的决定（可追溯，不等同用户指令）
 *
 * 宁缺毋滥：只认显式信号词，不做泛化总结。抽不到就不写——空记忆比错记忆好。
 */

export interface MemoryCandidate {
  text: string
  tags: string[]
}

/** 触发词 → 记忆类型。顺序即优先级，命中即停。 */
const SIGNALS: [RegExp, string][] = [
  [/(记住|请记|别忘了|以后都|下次.*记得)/, 'world'], // i18n-ignore: 中文触发词正则，非 UI 文案
  [/(我偏好|我喜欢|我习惯|我讨厌|我不喜欢|不要用|别再|禁止|必须|我要求|我的原则是)/, 'preference'], // i18n-ignore: 中文触发词正则
  [/(目标是|我希望|我想要.*长期|我的目标)/, 'preference'], // i18n-ignore: 中文触发词正则
]

/** 明显是一次性任务、不该进长期记忆的噪音。 */
const TRANSIENT = /(这次|现在|刚才|今天|临时|先这样|帮我|能不能|怎么|为什么)/ // i18n-ignore: 中文噪音词正则

/** 从一段用户消息里抽候选记忆；纯函数，便于单测。 */
export function extractMemoryCandidates(userText: string): MemoryCandidate[] {
  const clean = userText
    .replace(/\[(?:项目上下文|附件|图片|文件)[^\]]*\]/g, '') // i18n-ignore: 剥内核注入的中文前缀
    .replace(/【主动任务[^\】]*】/, '') // i18n-ignore: 同上
    .trim()
  if (clean.length < 6 || clean.length > 400) return []

  const out: MemoryCandidate[] = []
  for (const part of clean.split(/[。！？\n；;]+/)) {
    const line = part.trim()
    if (line.length < 6 || line.length > 200 || TRANSIENT.test(line)) continue
    const hit = SIGNALS.find(([re]) => re.test(line))
    if (!hit) continue
    const text = line.replace(/^(请|帮我)?(记住|请记|别忘了)[：:\s]*/, '').trim() // i18n-ignore: 中文前缀剥离
    if (text.length < 4) continue
    out.push({ text, tags: [hit[1], 'dialogue-extract'] })
  }
  return out.slice(0, 3)
}

/** 与已有效记忆去重：文本相同（忽略首尾空白）即跳过。 */
export function dedupeCandidates(
  candidates: MemoryCandidate[],
  existingTexts: string[],
): MemoryCandidate[] {
  const seen = new Set(existingTexts.map((t) => t.trim()))
  return candidates.filter((c) => {
    const key = c.text.trim()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
