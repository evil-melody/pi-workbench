/**
 * B4 上下文预算：prompt 前缀（taskContextPreamble 产物）拼接前的 token 计量与裁剪。
 *
 * 之前 taskContext/引用资料是无差别整段拼进 prompt：项目指令一长、引用一多，
 * 上下文预算就被前缀吃光，正文反而没空间。这里提供 CJK 感知的粗估 + 按行
 * 优先级裁剪：项目名与指令优先保留，能力/引用清单超预算时截断并显式标注
 * 「已裁剪」——绝不让内核悄悄丢上下文，用户能看到裁剪发生了。
 *
 * 纯函数、无 Tauri 依赖，vitest 可直接跑（tests/contextBudget.spec.ts）。
 */

/** 粗估：CJK 字符信息密度高（≈0.75 token/字），拉丁系 ≈4 字符/token。 */
const CJK_TOKEN_RATIO = 0.75
const LATIN_CHARS_PER_TOKEN = 4

/** 前缀默认预算（token）。给正文留出绝对大头；内核上下文窗口不同模型差异大，
 * 这里只管「前缀别失控」，整窗预算属内核 autocompact 的职责（B3 已接原生 compact）。 */
export const DEFAULT_PREAMBLE_BUDGET_TOKENS = 4000

/** 单行硬上限：单行超长（如超长指令）时截断并标注。 */
const MAX_LINE_TOKENS = 2000

function cjkCount(s: string): number {
  // CJK 统一表意文字 + 扩展 A + 假名/谚文一并按 CJK 密度算。
  const m = s.match(/[\u3000-\u9fff\u3040-\u30ff\uac00-\ud7af]/g)
  return m ? m.length : 0
}

/** token 粗估。不求精确分词，只求「量级正确」——预算管理要的是失控检测，不是计费。 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const cjk = cjkCount(text)
  const rest = text.length - cjk
  return Math.ceil(cjk * CJK_TOKEN_RATIO + rest / LATIN_CHARS_PER_TOKEN)
}

export interface TrimResult {
  /** 裁剪后的前缀（可能带「已裁剪」标注行）。 */
  preamble: string
  /** 原始估算 tokens。 */
  originalTokens: number
  /** 裁剪后估算 tokens。 */
  finalTokens: number
  /** 是否发生了裁剪。 */
  trimmed: boolean
}

/** 单行截断：超 MAX_LINE_TOKENS 掐断并标注省略长度。 */
function clampLine(line: string): string {
  if (estimateTokens(line) <= MAX_LINE_TOKENS) return line
  // 按 token 比例换算可保留的字符数（粗略即可），尾部留标注空间。
  const keep = Math.floor((MAX_LINE_TOKENS - 12) / (estimateTokens(line) / line.length))
  return `${line.slice(0, Math.max(0, keep))}…[单行超限已截断]`
}

/**
 * 按预算裁剪前缀。
 *
 * 行优先级：`[项目]`/`[配置修订`（元信息行）> 指令正文 > `[本次可用能力]` > `[本次引用]`。
 * 超预算时从最低优先级行开始丢/截，丢掉的行汇总成一条标注行（显式可见）。
 */
export function trimPreamble(
  preamble: string,
  budgetTokens: number = DEFAULT_PREAMBLE_BUDGET_TOKENS,
): TrimResult {
  const raw = (preamble ?? '').trim()
  const originalTokens = estimateTokens(raw)
  if (!raw) return { preamble: '', originalTokens: 0, finalTokens: 0, trimmed: false }

  // 单行硬上限始终生效（与预算无关）：再短的预算配置也不该让一行把窗口吃光。
  const lines = raw.split('\n').map(clampLine)
  const clampedTokens = lines.reduce((s, l) => s + estimateTokens(l), 0)
  if (clampedTokens <= budgetTokens) {
    const out = lines.join('\n')
    const clampedAny = out !== raw
    return {
      preamble: out,
      originalTokens,
      finalTokens: estimateTokens(out),
      trimmed: clampedAny,
    }
  }

  const isMeta = (l: string) => l.startsWith('[项目]') || l.startsWith('[配置修订')
  const isCaps = (l: string) => l.startsWith('[本次可用能力]')
  const isRefs = (l: string) => l.startsWith('[本次引用]')
  // 元信息 > 其余正文 > 能力 > 引用（正文里含指令，优先级仅次于元信息）。
  const rank = (l: string) => (isMeta(l) ? 0 : isCaps(l) ? 2 : isRefs(l) ? 3 : 1)

  // 先全保留，再从最低优先级行开始丢，直到进预算；元信息行永不丢。
  const total = clampedTokens
  const keepFlags: boolean[] = lines.map(() => true)
  let remaining = total
  const dropped: string[] = []
  const order = lines
    .map((l, i) => ({ l, i, r: rank(l) }))
    .filter((x) => !isMeta(x.l))
    .sort((a, b) => b.r - a.r)
  for (const item of order) {
    if (remaining <= budgetTokens) break
    remaining -= estimateTokens(item.l)
    keepFlags[item.i] = false
    dropped.push(item.l)
  }
  const kept = lines.filter((_, i) => keepFlags[i])

  let out = kept.join('\n')
  if (dropped.length) {
    const dTokens = dropped.reduce((s, l) => s + estimateTokens(l), 0)
    out += `\n[已裁剪] 前 ${dropped.length} 行（≈${dTokens} tokens）超出前缀预算被省略，需要时让用户贴具体内容`
  }
  return { preamble: out, originalTokens, finalTokens: estimateTokens(out), trimmed: true }
}
