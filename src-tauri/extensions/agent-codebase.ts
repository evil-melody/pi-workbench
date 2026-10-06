/**
 * Pi extension: 代码库检索（agent-codebase）
 *
 * 把 `codebase-memory-mcp` 的检索能力对象化为 Pi 工具，让内核能直接
 * `codebase_search` / `codebase_architecture` / `codebase_query` 当前工作目录。
 *
 * 前置：当前目录必须已经过索引。索引由 Pi Workbench 的 Rust 侧
 * `project_index_codebase` 在「项目激活 + 绑定目录」时自动跑（见
 * `src-tauri/src/codebase.rs`）。本扩展只负责「查」不负责「建」——
 * 建索引是重活，走工作台那条路，避免在内核进程里卡住对话。
 *
 * 项目名解析：codebase-memory-mcp 的项目名不是简单的路径 slug，
 * 所以必须 `list_projects` 拿 `root_path ↔ name` 映射，再用 cwd 的
 * realpath 匹配，不能自己猜名字（猜错就查不到）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'

type ToolResult = { content: string; details?: unknown; terminate?: boolean }

const TOOL = 'codebase-memory-mcp'

/** 定位二进制：环境变量 > PATH > 常见安装位置。与 Rust 侧 `find_binary` 对齐。 */
function findBinary(): string {
  const fromEnv = process.env.CODEBASE_MEMORY_MCP_PATH
  if (fromEnv && existsSync(fromEnv)) return fromEnv

  const pathEnv = process.env.PATH ?? ''
  for (const dir of pathEnv.split(path.delimiter)) {
    const candidate = path.join(dir, TOOL)
    if (existsSync(candidate)) return candidate
  }
  const home = process.env.HOME ?? ''
  const candidates = [
    path.join(home, '.local', 'bin', TOOL),
    path.join(home, '.cargo', 'bin', TOOL),
    '/opt/homebrew/bin/' + TOOL,
    '/usr/local/bin/' + TOOL,
    '/usr/bin/' + TOOL,
  ]
  for (const c of candidates) if (existsSync(c)) return c
  throw new Error(`${TOOL} 未安装：请安装后重试，或设置 CODEBASE_MEMORY_MCP_PATH`)
}

/** 运行一次 CLI 并取回文本结果（剥离 deprecation warning 等前导行）。 */
function runCli(tool: string, args: Record<string, unknown>): string {
  const bin = findBinary()
  let raw: string
  try {
    raw = execFileSync(
      bin,
      ['cli', '--json', tool, JSON.stringify(args)],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    )
  } catch (e: any) {
    // 非零退出码：把 stderr 透出来，而不是吞掉。
    const msg = e?.stderr ? String(e.stderr).trim() : String(e?.message ?? e)
    throw new Error(`${TOOL} ${tool} 失败：${msg}`)
  }
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end < 0) return raw.trim()
  const env = JSON.parse(raw.slice(start, end + 1))
  if (env.isError) {
    const err =
      env.structuredContent?.error ??
      env.content?.[0]?.text ??
      '未知错误'
    throw new Error(String(err))
  }
  if (env.structuredContent) return JSON.stringify(env.structuredContent, null, 2)
  return env.content?.[0]?.text ?? ''
}

/** cwd：内核注入 PI_CODING_AGENT_DIR，否则退回进程 cwd（项目目录）。 */
function repoRoot(): string {
  const dir = process.env.PI_CODING_AGENT_DIR ?? process.cwd()
  try {
    return realpathSync(dir)
  } catch {
    return dir
  }
}

/** 通过 list_projects 把 cwd 解析成 codebase-memory-mcp 的项目名。 */
function resolveProjectName(): string | null {
  const repo = repoRoot()
  const text = runCli('list_projects', {})
  // list_projects 文本形如：`  name /abs/root_path branch` 多行。
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('projects:') || trimmed.startsWith('total:') ||
        trimmed.startsWith('returned:') || trimmed.startsWith('has_more:')) continue
    const parts = trimmed.split(/\s+/)
    const name = parts[0]
    const root = parts[1]
    if (!name || !root) continue
    try {
      if (realpathSync(root) === repo) return name
    } catch {
      if (root === repo) return name
    }
  }
  return null
}

export default function (pi: any) {
  pi.registerTool({
    name: 'codebase_status',
    label: '代码库索引状态',
    description:
      '查看当前工作目录是否已被 codebase-memory-mcp 索引，以及节点/边数。未索引时提示先在工作台打开项目',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    execute: async (_id: string): Promise<ToolResult> => {
      let name: string | null
      try {
        name = resolveProjectName()
      } catch (e: any) {
        return { content: `无法解析代码库项目：${String(e?.message ?? e)}`, terminate: false }
      }
      if (!name) {
        return {
          content:
            '当前目录尚未被索引。请在 Pi Workbench 中打开该项目（绑定工作目录）以触发自动索引，然后再检索。',
          terminate: false,
        }
      }
      try {
        const text = runCli('index_status', { project: name })
        return { content: `项目 ${name} 索引状态：\n${text}`, details: { project: name } }
      } catch (e: any) {
        return { content: `读取索引状态失败：${String(e?.message ?? e)}`, details: { project: name } }
      }
    },
  })

  pi.registerTool({
    name: 'codebase_search',
    label: '代码库检索',
    description: '在当前代码库里按关键词/正则检索符号与文本匹配（codebase-memory-mcp search_code）',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '要检索的模式（默认子串，regex=true 时为正则）' },
        regex: { type: 'boolean', description: '是否按正则匹配，默认 false' },
        file_pattern: { type: 'string', description: '可选，按文件名/后缀过滤，如 "*.rs"' },
        limit: { type: 'number', description: '返回条数上限，默认 10' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    execute: async (_id: string, args: any): Promise<ToolResult> => {
      const pattern = String(args?.pattern ?? '').trim()
      if (!pattern) return { content: 'pattern 为空', terminate: false }
      const name = resolveProjectName()
      if (!name) return { content: '当前目录未被索引，无法检索。请先在 Pi Workbench 打开项目。', terminate: false }
      try {
        const out = runCli('search_code', {
          pattern,
          project: name,
          regex: Boolean(args?.regex),
          file_pattern: args?.file_pattern ?? '',
          limit: Number(args?.limit) || 10,
        })
        return { content: out || '没有命中', details: { project: name, pattern } }
      } catch (e: any) {
        return { content: `检索失败：${String(e?.message ?? e)}`, details: { project: name } }
      }
    },
  })

  pi.registerTool({
    name: 'codebase_architecture',
    label: '代码库架构',
    description: '导出当前代码库的架构概览（语言/包/入口点/依赖环等，codebase-memory-mcp get_architecture）',
    parameters: {
      type: 'object',
      properties: {
        aspects: {
          type: 'array',
          items: { type: 'string' },
          description: '视角：all=全部；overview=除文件树外的概览；省略=语言/包/入口点；cycles 需显式开启',
        },
        path: { type: 'string', description: '可选目录前缀，如 apps/hoa' },
      },
      additionalProperties: false,
    },
    execute: async (_id: string, args: any): Promise<ToolResult> => {
      const name = resolveProjectName()
      if (!name) return { content: '当前目录未被索引，无法导出架构。请先在 Pi Workbench 打开项目。', terminate: false }
      try {
        const out = runCli('get_architecture', {
          project: name,
          aspects: Array.isArray(args?.aspects) ? args.aspects.map(String) : ['all'],
          path: args?.path ?? '',
        })
        return { content: out || '没有可展示的架构信息', details: { project: name } }
      } catch (e: any) {
        return { content: `导出架构失败：${String(e?.message ?? e)}`, details: { project: name } }
      }
    },
  })

  pi.registerTool({
    name: 'codebase_query',
    label: '代码库图查询',
    description: '用 Cypher 查询代码知识图谱（codebase-memory-mcp query_graph），如依赖、调用关系、影响半径',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Cypher 查询语句' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    execute: async (_id: string, args: any): Promise<ToolResult> => {
      const query = String(args?.query ?? '').trim()
      if (!query) return { content: 'query 为空', terminate: false }
      const name = resolveProjectName()
      if (!name) return { content: '当前目录未被索引，无法查询图谱。请先在 Pi Workbench 打开项目。', terminate: false }
      try {
        const out = runCli('query_graph', { query, project: name })
        return { content: out || '查询无结果', details: { project: name } }
      } catch (e: any) {
        return { content: `图谱查询失败：${String(e?.message ?? e)}`, details: { project: name } }
      }
    },
  })

  try {
    pi.setActiveTools(['codebase_status', 'codebase_search', 'codebase_architecture', 'codebase_query'])
  } catch {
    /* 运行时未就绪则跳过 */
  }
}
