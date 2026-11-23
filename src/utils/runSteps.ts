import type { PiEventRow } from './piEventKind'

/**
 * 本轮工具调用：按内核信封 runId 聚合，跨轮不串台。
 *
 * 不再用「最后 turn_start 之后」当锚点——真实内核的 turn_start 可能晚于
 * 首批工具调用（或不发），旧锚点会把整轮切掉，出现「轨迹徽章 51、步骤条
 * 共 0 步」的矛盾。落定/退出是轮次边界；老事件无信封时按边界回退。
 */
export function currentRunToolCalls(evs: PiEventRow[]): PiEventRow[] {
  const calls = evs.filter((e) => e.kind === 'tool_call')
  if (!calls.length) return []
  const runId = calls[calls.length - 1].runId
  if (runId) return calls.filter((e) => e.runId === runId)

  let boundary = -1
  for (let i = evs.length - 1; i >= 0; i--) {
    if (evs[i].kind === 'settled' || evs[i].kind === 'exit') {
      boundary = i
      break
    }
  }
  if (boundary < 0) return calls
  const anchor = evs[boundary]
  const pos = calls.findIndex((e) => e.at > anchor.at)
  return pos >= 0 ? calls.slice(pos) : []
}
