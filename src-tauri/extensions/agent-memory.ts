/**
 * Pi extension: 分层记忆（agent-memory）
 *
 * 长期记忆的写入与召回。本仓不引入外部依赖，只把记忆能力对象化为 Pi 工具：
 * 模型在对话里直接 `memory_store` / `memory_recall`。状态落
 * `<base>/.pi/memory/memory.jsonl`，与 Rust `agent_memory_list` 共用同一份磁盘状态，
 * agent 面与人面一致。
 *
 * 召回为多信号词面评分（中文 bigram + 标签加权 + 覆盖率归一 + 时效微加分），
 * 非语义向量；语义 RAG 列入 docs/AGENT-OPS.md §B 期。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

type ToolResult = { content: string; details?: unknown; terminate?: boolean }
type MemEntry = { ts: number; text: string; tags: string[] }

/** 与 Pi 共根：启动时被注入 PI_CODING_AGENT_DIR，否则退回 cwd。 */
function piHome(): string {
  return process.env.PI_CODING_AGENT_DIR ?? process.cwd()
}
function memoryFile(): string {
  return path.join(piHome(), '.pi', 'memory', 'memory.jsonl')
}

function loadAll(): MemEntry[] {
  const f = memoryFile()
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as MemEntry
      } catch {
        return null
      }
    })
    .filter((x): x is MemEntry => x !== null)
}

/**
 * 查询切词：拉丁词按空白/标点切；CJK 无空格，用 bigram 粒度
 * （「知识库检索」→ 知识/识库/检索）。bigram 是词面召回里性价比最高的
 * 中文近似——unigram 噪声太大，真分词器引外部依赖，不合本仓约束。
 */
export function queryTerms(q: string): string[] {
  const terms: string[] = []
  for (const w of q.toLowerCase().split(/[\s,，。;；!！?？'"()（）\[\]{}]+/)) {
    if (!w) continue
    if (/[\u3000-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(w)) {
      if (w.length === 1) terms.push(w)
      else for (let i = 0; i < w.length - 1; i++) terms.push(w.slice(i, i + 2))
    } else {
      terms.push(w)
    }
  }
  return [...new Set(terms)]
}

/**
 * 多信号评分（B5 短期召回，词面而非语义向量）：
 * ① 命中信号：查询词在 text/tags 中的出现（tags 命中 ×2——显式标签更可信）；
 * ② 词长权重：越长的词信息量越大（bigram=2、拉丁长词按长度），抑制短词噪声；
 * ③ 覆盖率归一：按命中词数/总词数，避免「一条短记忆靠一个词撞分」；
 * ④ 时效微加分：近期条目 +最多 0.2（7 天半衰期指数衰减），只做 tie-break 不主导。
 */
export function scoreOf(q: string, e: MemEntry, now = Date.now()): number {
  const text = e.text.toLowerCase()
  const tags = (e.tags ?? []).join(' ').toLowerCase()
  const terms = queryTerms(q)
  if (!terms.length) return 0
  let hit = 0
  for (const t of terms) {
    const w = Math.min(t.length, 4) // bigram=2、拉丁词按长度，封顶 4 防长词独裁
    if (text.includes(t)) hit += w
    if (tags.includes(t)) hit += w * 2
  }
  if (hit === 0) return 0
  const coverage = terms.length ? hit / (terms.length * 4 * 3) : 0
  const ageDays = Math.max(0, (now - (e.ts ?? 0)) / 86_400_000)
  const recency = 0.2 * Math.pow(0.5, ageDays / 7)
  return coverage + recency
}

export default function (pi: any) {
  pi.registerTool({
    name: 'memory_store',
    label: '记忆写入',
    description: '把一条值得长期保留的信息写入分层记忆（ts/text/tags），供后续 memory_recall 召回',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记忆的内容' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '可选标签，便于分类与召回',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    execute: async (_id: string, args: any): Promise<ToolResult> => {
      const text = String(args?.text ?? '').trim()
      if (!text) return { content: 'text 为空，未写入', terminate: false }
      const tags = Array.isArray(args?.tags) ? args.tags.map(String) : []
      const entry: MemEntry = { ts: Date.now(), text, tags }
      const f = memoryFile()
      mkdirSync(path.dirname(f), { recursive: true })
      appendFileSync(f, JSON.stringify(entry) + '\n', 'utf8')
      return {
        content: `已写入记忆（共 ${loadAll().length} 条）`,
        details: { total: loadAll().length },
      }
    },
  })

  pi.registerTool({
    name: 'memory_recall',
    label: '记忆召回',
    description:
      '按多信号评分（词面命中 + 标签加权 + 覆盖率 + 时效）检索分层记忆，返回最相关的若干条。中文按 bigram 切词；语义向量召回属后续演进',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '召回关键词' },
        limit: { type: 'number', description: '返回条数上限，默认 5' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    execute: async (_id: string, args: any): Promise<ToolResult> => {
      const q = String(args?.query ?? '').trim()
      if (!q) return { content: 'query 为空', terminate: false }
      const limit = Math.max(1, Math.min(20, Number(args?.limit) || 5))
      const hits = loadAll()
        .map((e) => ({ e, s: scoreOf(q, e) }))
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, limit)
        .map((x) => ({
          text: x.e.text,
          tags: x.e.tags,
          ts: x.e.ts,
          score: x.s,
        }))
      if (!hits.length) return { content: '没有命中任何记忆', details: { hits: [] } }
      const lines = hits.map(
        (h, i) => `${i + 1}. [${h.tags.join(',') || '无标签'}] ${h.text}`,
      )
      return { content: lines.join('\n'), details: { hits } }
    },
  })

  pi.registerCommand('memory', {
    description: '显示记忆条数统计',
    handler: async (_arg: string, ctx: any) => {
      const all = loadAll()
      ctx.ui?.notify(`memory: ${all.length} 条`, 'info')
    },
  })

  try {
    pi.setActiveTools(['memory_store', 'memory_recall'])
  } catch {
    /* 运行时未就绪则跳过 */
  }
}
