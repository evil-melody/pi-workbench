/**
 * Pi extension: 分层记忆（agent-memory）
 *
 * 长期记忆的写入与召回。本仓不引入外部依赖，只把记忆能力对象化为 Pi 工具：
 * 模型在对话里直接 `memory_store` / `memory_recall`。状态落
 * `<base>/.pi/memory/memory.jsonl`，与 Rust `agent_memory_list` 共用同一份磁盘状态，
 * agent 面与人面一致。
 *
 * 召回首轮为关键词/全文匹配（非语义向量），语义 RAG 列入 docs/AGENT-OPS.md §B 期。
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

/** 关键词命中打分：查询词逐个出现即加分，重叠越多分越高。 */
function scoreOf(q: string, e: MemEntry): number {
  const hay = `${e.text} ${(e.tags ?? []).join(' ')}`.toLowerCase()
  const terms = q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  if (!terms.length) return 0
  let s = 0
  for (const t of terms) if (hay.includes(t)) s += 1
  return s
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
    description: '按关键词全文检索分层记忆，返回最相关的若干条',
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
