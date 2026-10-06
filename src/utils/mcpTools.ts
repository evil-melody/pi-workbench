/**
 * 解析 MCP `tools/list` 返回的工具对象。
 *
 * MCP 规范工具对象通常是 `{ name, description }`；
 * OpenAI 风格 function-call 包装为 `{ function: { name, description } }`。
 */
export function parseToolName(t: unknown): string {
  if (t == null) return 'unknown'
  if (typeof t === 'string') return t
  const anyT = t as any
  if (anyT.name) return String(anyT.name)
  if (anyT.function?.name) return String(anyT.function.name)
  return 'unknown'
}

export function parseToolDescription(t: unknown): string {
  if (t == null) return ''
  const anyT = t as any
  if (anyT.description) return String(anyT.description)
  if (anyT.function?.description) return String(anyT.function.description)
  return ''
}
