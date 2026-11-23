/**
 * M5 推荐源扩展侧单测（node --experimental-strip-types）：
 *   · topicFrom —— 从 prompt 抽主题短语；代码块/标记/空白剥掉；空返回 null
 *   · suggestFrom —— 三条延续问题；空文本不产
 *   · 默认导出挂 agent_before_settle：completed 轮产出条目，
 *     非 completed / 重复文本 / 异常不产。
 * 运行：node --experimental-strip-types scripts/test-harness-suggest.ts
 */
import {
  topicFrom,
  suggestFrom,
  SUGGEST_CUSTOM_TYPE,
} from '../src-tauri/extensions/agent-suggest.ts'

let passed = 0
let failed = 0
function assert(cond: boolean, label: string) {
  if (cond) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.log(`  ✗ ${label}`)
  }
}

// —— topicFrom ——
assert(topicFrom('  给报表页加 CSV 导出  ') === '给报表页加 CSV 导出', '空白剥离')
assert(topicFrom('a'.repeat(30)) === `${'a'.repeat(24)}…`, '超长截断 24 字')
assert(topicFrom('```js\ncode\n```') === null, '纯代码块不产主题')
assert(topicFrom('  \n\t ') === null, '空白文本不产主题')
assert(topicFrom('<b>加导出</b>') === '加导出', '标记剥除')

// —— suggestFrom ——
const three = suggestFrom('给报表页加 CSV 导出')
assert(three.length === 3, '产三条')
assert(three.every((s) => s.includes('给报表页加 CSV 导出')), '每条带主题')
assert(new Set(three).size === 3, '三条互不重复')
assert(suggestFrom('').length === 0, '空文本不产推荐')

// —— 事件挂点 ——
import registerSuggest from '../src-tauri/extensions/agent-suggest.ts'
function fire(event: any) {
  const appended: any[] = []
  let handler: ((e: any) => void) | null = null
  const pi = {
    on: (name: string, fn: (e: any) => void) => {
      if (name === 'agent_before_settle') handler = fn
    },
    appendEntry: (type: string, data: unknown) => appended.push({ type, data }),
  }
  registerSuggest(pi)
  handler!(event)
  return appended
}
const userEvent = {
  outcome: 'completed',
  context: { llmMessages: [{ role: 'user', content: '给报表页加 CSV 导出' }] },
}
const first = fire(userEvent)
assert(first.length === 1 && first[0].type === SUGGEST_CUSTOM_TYPE, 'completed 轮落一条 custom 条目')
assert((first[0].data as any).suggestions.length === 3, '条目带三条推荐')
assert(fire({ ...userEvent, outcome: 'error' }).length === 0, '非 completed 轮不产')
assert(
  fire({ ...userEvent, context: { llmMessages: [{ role: 'assistant', content: 'x' }] } }).length === 0,
  '无 user 文本不产',
)
assert(
  fire({ ...userEvent, context: { llmMessages: [{ role: 'user', content: [{ type: 'text', text: '分块文本' }] }] } }).length === 1,
  '数组形状 content 可读',
)

console.log(`\nM5 推荐源扩展：${passed} 通过 / ${failed} 失败`)
process.exit(failed ? 1 : 0)
