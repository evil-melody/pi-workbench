/**
 * 阶段 2 harness：记忆事件流物化 / 召回注入 / 主动任务写入限流。
 *
 * 运行：node --experimental-strip-types scripts/test-harness-p4.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import memoryExtension, { buildAddendum, entryId, materialize } from '../src-tauri/extensions/agent-memory.ts'

let passed = 0
function ok(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`✓ ${name}`)
  } catch (e) {
    console.error(`✗ ${name}\n${e}`)
    process.exit(1)
  }
}

const idOf = (ts: number, text: string) => entryId(ts, text)

ok('物化：update 覆盖正文并保留 id', () => {
  const id = idOf(1000, '用中文')
  const out = materialize([
    { ts: 1000, text: '用中文', tags: [] },
    { op: 'update', id, ts: 2000, text: '用英文', tags: ['偏好'] },
  ])
  assert.equal(out.length, 1)
  assert.equal(out[0].text, '用英文')
  assert.deepEqual(out[0].tags, ['偏好'])
})

ok('物化：delete 后 purge，召回视图为空', () => {
  const id = idOf(1000, '用中文')
  const out = materialize([
    { ts: 1000, text: '用中文', tags: [] },
    { op: 'delete', id, ts: 2000, purgeAt: 3000 },
    { op: 'purge', id, ts: 2001 },
  ])
  assert.equal(out.length, 0)
})

ok('物化：source / jobId 保留', () => {
  const out = materialize([{ ts: 1, text: 'x', tags: [], source: 'proactive', jobId: 'job-1' }])
  assert.equal(out[0].source, 'proactive')
  assert.equal(out[0].jobId, 'job-1')
})

// —— 落在临时目录里的注入与限流 ——
const home = mkdtempSync(path.join(tmpdir(), 'mem-p4-'))
process.env.PI_CODING_AGENT_DIR = home
const memDir = path.join(home, '.pi', 'memory')
mkdirSync(memDir, { recursive: true })
const ts = Date.now()
const seeded = [
  { id: idOf(ts, '用户偏好电报体汇报'), ts, text: '用户偏好电报体汇报', tags: ['偏好'] },
  { id: idOf(ts + 1, '数据库连不上先看 5432 端口'), ts: ts + 1, text: '数据库连不上先看 5432 端口', tags: ['排障'] },
]
writeFileSync(path.join(memDir, 'memory.jsonl'), seeded.map((e) => JSON.stringify(e)).join('\n') + '\n')
writeFileSync(
  path.join(memDir, 'profile.json'),
  JSON.stringify({ preference: { value: '电报体', evidence: [seeded[0].id], updatedAt: ts } }),
)

ok('注入：画像 + 召回同一段 addendum', () => {
  const text = buildAddendum('数据库连不上怎么查')
  assert.ok(text.includes('用户画像'))
  assert.ok(text.includes('电报体'))
  assert.ok(text.includes('5432'))
})

ok('注入：无关输入不注入记忆', () => {
  const text = buildAddendum('今天天气怎么样')
  assert.ok(!text.includes('5432'))
})

// —— 用假 pi 捕获工具，验证主动任务的打标与单轮上限 ——
const tools = new Map<string, any>()
let onStart: ((ctx: any) => any) | null = null
memoryExtension({
  registerTool: (t: any) => tools.set(t.name, t),
  registerCommand: () => {},
  on: (name: string, fn: any) => {
    if (name === 'before_agent_start') onStart = fn
  },
  setActiveTools: () => {},
})

const store = tools.get('memory_store')
const results: string[] = []
onStart!({ prompt: '【主动任务 job-9】每日巡检\n\n检查服务状态', systemPromptOptions: {} })
for (let i = 0; i < 4; i++) {
  const r = await store.execute('id', { text: `第 ${i} 条结论` })
  results.push(r.content)
}
const raw = readFileSync(path.join(memDir, 'memory.jsonl'), 'utf8')
const added = raw
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l))
  .filter((x) => x.source === 'proactive')
if (added.length !== 3) {
  console.error(`✗ 主动任务写入应为 3 条，实际 ${added.length}`)
  process.exit(1)
}
if (added.some((x) => x.jobId !== 'job-9' || !x.tags.includes('proactive'))) {
  console.error('✗ 主动任务条目缺少 jobId / proactive 标签')
  process.exit(1)
}
if (!results[3].includes('上限')) {
  console.error(`✗ 第 4 条应被拒绝，实际：${results[3]}`)
  process.exit(1)
}
passed += 1
console.log('✓ 主动任务：自动打标 + 单轮最多 3 条')

console.log(`\n${passed} passed`)
