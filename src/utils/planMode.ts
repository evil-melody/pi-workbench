/**
 * G5 Plan 模式（对齐 Cursor Plan mode / Claude Code 计划批准流）：
 *
 * 内核没有独立的 plan RPC，用 prompt 前缀注入实现——发送前把计划指令
 * 拼在最外（项目上下文之前），内核先输出分步计划、不调用工具；前端把
 * 该轮 assistant 回复解析成计划卡，用户点「开始执行」才发执行 prompt。
 *
 * 前缀置最外是有意的：`splitPromptBody`（usePi）按 `\n\n---\n\n` 切分时
 * 前缀落在被剥掉的上下文侧，回放的 user 气泡不会露出指令原文。
 */

/** 计划指令：先出编号分步计划，停手等确认。 */
export const PLAN_INSTRUCTION =
  '[计划模式] 请先不要调用任何工具。先输出一份分步计划（编号列表，每步一行），等用户确认后再按计划执行。'

/** plan 轮发送：指令前缀拼在最外。 */
export function withPlanInstruction(body: string): string {
  return `${PLAN_INSTRUCTION}\n\n${body}`
}

/** 剥掉正文头部的计划指令（无 preamble 时回放需要；有 preamble 时已被 `---` 切分剥掉）。 */
export function stripPlanInstruction(body: string): string {
  const head = `${PLAN_INSTRUCTION}\n\n`
  if (body.startsWith(head)) return body.slice(head.length)
  return body === PLAN_INSTRUCTION ? '' : body
}

/** 单行最大步骤数：防模型失控输出撑爆卡片。 */
const MAX_STEPS = 20

/**
 * 从模型回复里解析分步计划：编号（`1.`/`1、`/`1)`）或 bullet（`-`/`*`/`•`）
 * 行 → 步骤文本；零命中返回空数组（调用方按普通回复处理）。
 */
export function parsePlanSteps(text: string): string[] {
  if (!text) return []
  const steps: string[] = []
  for (const raw of text.split('\n')) {
    const m = /^\s*(?:\d+[.、)]|[-*•])\s*(.+?)\s*$/.exec(raw)
    if (!m) continue
    let s = m[1].trim()
    // 整行加粗（`**步骤**`）是模型常见习惯，卡片里按纯文本展示，去掉标记。
    s = s.replace(/^\*\*(.+)\*\*$/, '$1').replace(/^__(.+)__$/, '$1').trim()
    // 空步骤 / 纯符号行（`1. -`）丢弃；单字符步骤（「A」「B」）是合法的，不能按长度一刀切。
    if (!s || /^[-*•\s]+$/.test(s)) continue
    steps.push(s)
    if (steps.length >= MAX_STEPS) break
  }
  return steps
}

/** 用户确认计划后的执行 prompt：已批准步骤 + 原始任务（执行时不能丢目标）。 */
export function buildExecPrompt(task: string, steps: string[]): string {
  const list = steps.map((s, i) => `${i + 1}. ${s}`).join('\n')
  return `计划已确认，请按以下步骤执行：\n${list}\n\n原始任务：${task}`
}
