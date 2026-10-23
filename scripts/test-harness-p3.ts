/**
 * P2 harness 单测：B5 记忆评分召回（agent-memory.ts 的 queryTerms/scoreOf）。
 * 运行：node --experimental-strip-types scripts/test-harness-p3.ts
 */
import assert from 'node:assert/strict'
import { queryTerms, scoreOf } from '../src-tauri/extensions/agent-memory.ts'

let passed = 0
function assert2(cond: boolean, name: string) {
  if (!cond) {
    console.error(`✗ ${name}`)
    process.exit(1)
  }
  passed++
  console.log(`✓ ${name}`)
}

// ---- queryTerms ----
assert2(
  JSON.stringify(queryTerms('知识库检索')) === JSON.stringify(['知识', '识库', '库检', '检索']),
  'queryTerms: CJK bigram 切分',
)
assert2(
  queryTerms('hello world').join(',') === 'hello,world',
  'queryTerms: 拉丁按空白切词',
)
assert2(
  queryTerms('知识库 hello').join(',') === '知识,识库,hello',
  'queryTerms: 中英混排',
)
assert2(
  new Set(queryTerms('知识知识')).size === 2,
  'queryTerms: 去重',
)
assert2(queryTerms('').length === 0, 'queryTerms: 空串安全')

const NOW = 1_800_000_000_000
const mem = (text: string, tags: string[] = [], ts = NOW): any => ({ ts, text, tags })

// ---- scoreOf ----
// 命中 > 无命中
assert2(
  scoreOf('知识库', mem('知识库的设计文档'), [], NOW) > 0,
  'scoreOf: 命中得正分',
)
assert2(scoreOf('量子物理', mem('知识库的设计文档')) === 0, 'scoreOf: 未命中为 0')

// 标签命中权重高于正文命中
const tagHit = scoreOf('检索', mem('无关正文', ['检索']), NOW)
const textHit = scoreOf('检索', mem('检索相关正文'), NOW)
assert2(tagHit > textHit, 'scoreOf: tags 命中权重 > 正文命中')

// 长词权重高于短词（bigram=2 vs 单字=1）
const longTerm = scoreOf('检索', mem('检索')) // bigram
const shortTerm = scoreOf('搜', mem('搜')) // 单字
assert2(longTerm > shortTerm, 'scoreOf: 词长权重（长词信息量大）')

// 时效：新条目分高于旧条目（同等内容）
const fresh = scoreOf('知识', mem('知识', [], NOW), NOW)
const old = scoreOf('知识', mem('知识', [], NOW - 30 * 86_400_000), NOW)
assert2(fresh > old, 'scoreOf: 时效衰减（新记忆 tie-break 加分）')
assert2(fresh - old < 0.2 + 1e-9, 'scoreOf: 时效只是微加分不主导')

// 覆盖率：命中全部词 > 命中部分词
const full = scoreOf('知识库 检索', mem('知识库检索一次到位'), NOW)
const partial = scoreOf('知识库 检索', mem('知识库的来历'), NOW)
assert2(full > partial, 'scoreOf: 覆盖率归一（全命中 > 部分命中）')

// 中文 bigram 跨词命中：查询「知识库」对正文「知识库」全部 bigram 命中
assert2(scoreOf('知识库', mem('知识库')) > scoreOf('知识库', mem('知识')), 'scoreOf: bigram 全命中 > 单命中')

console.log(`\n${passed} assertions passed`)
