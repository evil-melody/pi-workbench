/**
 * 从对话文本里抽取 markdown 复选框任务清单（`- [ ]` / `- [x]`）。
 *
 * 用途：Pi 在计划类回复里本来就爱用 markdown checklist 表达任务拆分，
 * 没必要为「工作流面板」另造一份内核协议——直接读它已经写出来的清单，
 * 面板显示的就是真实任务，而不是写死的四个阶段。
 *
 * 纯函数、不依赖 Tauri 与 Vue，便于单测。
 */

export interface TodoItem {
  /** 同一消息内唯一。 */
  id: string
  /** 所属消息 id：同名任务在不同消息里会被视作两条独立任务。 */
  messageId: string
  text: string
  done: boolean
}

const CHECKBOX_LINE = /^\s*(?:[-*+]|\d+[.)])\s*\[([ xX])\]\s*(.*)$/

export function parseTodoList(
  messages: { id: string; role: string; text?: string; streaming?: boolean }[],
): TodoItem[] {
  const out: TodoItem[] = []

  for (const m of messages) {
    if (m.role !== 'assistant' || m.streaming) continue
    const seen = new Set<string>()
    ;(m.text ?? '')
      .split('\n')
      .forEach((line, i) => {
        const hit = CHECKBOX_LINE.exec(line)
        if (!hit) return
        const text = hit[2].trim()
        if (!text || seen.has(text)) return
        seen.add(text)
        out.push({
          id: `${m.id}#${i}`,
          messageId: m.id,
          text,
          done: hit[1].toLowerCase() === 'x',
        })
      })
  }

  return out
}

/** 清单里已有的已完成项，用于「保留 Pi 的勾选结果，不被本地状态覆盖」。 */
export function doneTexts(todo: TodoItem[]): string[] {
  return todo.filter((t) => t.done).map((t) => t.text)
}
