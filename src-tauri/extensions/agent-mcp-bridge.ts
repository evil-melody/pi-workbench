/**
 * Pi extension: MCP 桥接（agent-mcp-bridge）
 *
 * 解决 WORKDSH-ALIGN-26 的 A6：MCP server 跑在 Tauri 侧（mcp.rs 管理连接与连接器 UI），
 * 但 Pi 内核拿不到这些工具，连接器面板「注入 Pi」在内核侧是无效操作。
 *
 * 本桥接在 Pi 进程内自带一个最小 MCP stdio 客户端，按 Tauri `mcp.rs` 同写的
 * `<app_config_dir>/mcp.json`（服务标识 → command/args）惰性建连并转发调用，
 * 使 Pi（agent）能通过 `mcp_call` 工具实际使用已连接的 MCP 工具。
 *
 * 设计取舍（已在 md 第六章注明）：
 *   · 每个被 Pi 调用的 server 会在 Pi 侧额外起一个 stdio 连接（与 Tauri mcp.rs 各自持有一份），
 *     轻量 server 可接受；后续可收敛为单一 owner（P2）。
 *   · 工具名透传：本实现暴露统一 `mcp_call(server, tool, arguments)` 入口，agent 显式指定；
 *     完全透明的「工具名直接注入 Pi 工具表」需 Pi 内核原生 MCP 支持（当前 0.87.1 无），故后置。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

interface PendingEntry {
  resolve: (v: any) => void
  reject: (e: any) => void
}

/** 最小 MCP stdio 客户端：JSON-RPC 2.0，按行分隔。 */
export class McpClient {
  private proc: ChildProcess
  private buf = ''
  private id = 0
  private pending = new Map<number, PendingEntry>()

  private constructor(proc: ChildProcess) {
    this.proc = proc
    const stdout = proc.stdout!
    stdout.setEncoding('utf8')
    stdout.on('data', (chunk: string) => this.onData(chunk))
  }

  static async connect(command: string, args: string[], timeoutMs = 10_000): Promise<McpClient> {
    const proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'ignore'] })
    if (!proc.pid) throw new Error(`启动 MCP server 失败: ${command}`)
    const client = new McpClient(proc)
    try {
      // 健壮性：server 提前退出（坏路径/启动即崩）不能让等待方永久挂死——
      // 超时与 exit 都要 reject，并顺手清理子进程。
      await Promise.race([
        client.request('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'pi-workbench', version: '0.1.0' },
        }),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error(`MCP server 初始化超时（${timeoutMs}ms）: ${command}`)),
            timeoutMs,
          )
          timer.unref?.()
          proc.once('exit', () => reject(new Error(`MCP server 启动即退出: ${command}`)))
        }),
      ])
    } catch (e) {
      try { proc.kill() } catch { /* 已退出 */ }
      throw e
    }
    client.notify('notifications/initialized', {})
    return client
  }

  private onData(chunk: string) {
    this.buf += chunk
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (!line) continue
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.id === undefined || msg.id === null) continue
      const entry = this.pending.get(msg.id)
      if (!entry) continue
      this.pending.delete(msg.id)
      if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)))
      else entry.resolve(msg.result)
    }
  }

  private send(obj: any) {
    this.proc.stdin!.write(JSON.stringify(obj) + '\n')
  }

  private request(method: string, params: any): Promise<any> {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  private notify(method: string, params: any) {
    this.send({ jsonrpc: '2.0', method, params })
  }

  async listTools(): Promise<McpToolInfo[]> {
    const res = await this.request('tools/list', {})
    const tools = (res && res.tools) || []
    return (tools as any[]).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema || { type: 'object', properties: {}, required: [] },
    }))
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await this.request('tools/call', { name, arguments: args || {} })
    const content = res && res.content
    if (Array.isArray(content)) {
      return content
        .map((c: any) => (c.type === 'text' ? c.text : JSON.stringify(c)))
        .join('\n')
    }
    return JSON.stringify(res || {})
  }

  close() {
    try {
      this.proc.kill()
    } catch {
      /* ignore */
    }
  }
}

interface ServerDef {
  name: string
  command: string
  args: string[]
}

/// 已连接的 MCP 客户端缓存：服务标识 → 建连 Promise（避免重复 spawn）。
const clients = new Map<string, Promise<McpClient>>()

function mcpConfigPath(): string {
  const dir = process.env.PI_CODING_AGENT_DIR ?? process.cwd()
  return path.join(dir, 'mcp.json')
}

function loadServers(): ServerDef[] {
  const p = mcpConfigPath()
  if (!existsSync(p)) return []
  try {
    const arr = JSON.parse(readFileSync(p, 'utf8'))
    if (!Array.isArray(arr)) return []
    return (arr as any[])
      .filter((s) => s && s.name && s.command)
      .map((s) => ({
        name: String(s.name),
        command: String(s.command),
        args: Array.isArray(s.args) ? s.args.map(String) : [],
      }))
  } catch {
    return []
  }
}

async function getClient(server: string): Promise<McpClient> {
  if (!clients.has(server)) {
    const def = loadServers().find((s) => s.name === server)
    if (!def) throw new Error(`未知 MCP server: ${server}（连接器面板未配置或未连接）`)
    clients.set(server, McpClient.connect(def.command, def.args))
  }
  return clients.get(server)!
}

export default function (pi: any) {
  pi.registerTool({
    name: 'mcp_call',
    label: '调用 MCP 工具',
    description:
      '通过已连接的 MCP server 调用其工具。server 为连接器面板里配置的服务标识（可用 mcp_bridge 命令列出），tool 为工具名，arguments 为 JSON 字符串。',
    parameters: {
      type: 'object',
      properties: {
        server: { type: 'string', description: 'MCP server 标识' },
        tool: { type: 'string', description: '工具名' },
        arguments: { type: 'string', description: '工具参数，JSON 字符串' },
      },
      required: ['server', 'tool', 'arguments'],
      additionalProperties: false,
    },
    execute: async (
      _id: string,
      args: any,
    ): Promise<{ content: string; details?: unknown; terminate?: boolean }> => {
      const server = String(args?.server ?? '').trim()
      const tool = String(args?.tool ?? '').trim()
      if (!server || !tool) {
        return { content: 'server 与 tool 均为必填', terminate: false }
      }
      let parsed: Record<string, unknown> = {}
      try {
        parsed = args?.arguments ? JSON.parse(String(args.arguments)) : {}
      } catch (e: any) {
        return { content: `arguments 不是合法 JSON: ${e?.message ?? e}`, terminate: false }
      }
      try {
        const client = await getClient(server)
        const out = await client.callTool(tool, parsed)
        return { content: out, details: { server, tool } }
      } catch (e: any) {
        return { content: `MCP 调用失败: ${e?.message ?? e}`, terminate: false }
      }
    },
  })

  pi.registerTool({
    name: 'mcp_list_tools',
    label: '列出 MCP 工具',
    description: '列出所有已配置 MCP server 及其暴露的工具名与描述，供后续 mcp_call 调用前发现可用工具。',
    parameters: {
      type: 'object',
      properties: {
        server: {
          type: 'string',
          description: '可选：只列出某个 server 的工具；留空则列出全部',
        },
      },
      additionalProperties: false,
    },
    execute: async (
      _id: string,
      args: any,
    ): Promise<{ content: string; details?: unknown }> => {
      const only = String(args?.server ?? '').trim()
      const servers = loadServers().filter((s) => !only || s.name === only)
      if (!servers.length) {
        return { content: only ? `未知 MCP server: ${only}` : '（无已配置 MCP server）' }
      }
      const out: Array<{ server: string; tools: McpToolInfo[]; error?: string }> = []
      for (const s of servers) {
        try {
          const c = await getClient(s.name)
          out.push({ server: s.name, tools: await c.listTools() })
        } catch (e: any) {
          // 连接失败时仍返回 server 名，便于排查
          out.push({ server: s.name, tools: [], error: e?.message ?? String(e) })
        }
      }
      const text = out
        .map((o) => {
          const ts = (o.tools || []).map((t) => `  · ${t.name}: ${t.description ?? ''}`).join('\n')
          const err = (o as any).error ? `（连接失败：${(o as any).error}）` : ''
          return `- ${o.server}${err}\n${ts || '  （无工具）'}`
        })
        .join('\n')
      return { content: text, details: out }
    },
  })

  pi.registerCommand('mcp_bridge', {
    description: '列出已配置的 MCP server 与工具，供 agent 发现可用工具',
    handler: async (_arg: string, ctx: any) => {
      const servers = loadServers()
      const lines = ['已配置 MCP server:']
      if (!servers.length) lines.push('（无；请在连接器面板连接 MCP server）')
      for (const s of servers) {
        try {
          const c = await getClient(s.name)
          const tools = await c.listTools()
          lines.push(`- ${s.name}: ${tools.map((t) => t.name).join(', ') || '(无工具)'}`)
        } catch (e: any) {
          lines.push(`- ${s.name}: 连接失败 ${e?.message ?? e}`)
        }
      }
      ctx?.ui?.notify(lines.join('\n'), 'info')
    },
  })

  pi.registerCommand('mcp_refresh', {
    description: '清空 MCP 客户端缓存并关闭已有连接，使连接器面板的新配置立即生效',
    handler: async (_arg: string, ctx: any) => {
      let n = 0
      for (const [, p] of clients) {
        try {
          const c = await p
          c.close()
          n++
        } catch {
          /* ignore */
        }
      }
      clients.clear()
      ctx?.ui?.notify(`已刷新 MCP 连接缓存（关闭 ${n} 个）`, 'info')
    },
  })

  try {
    pi.setActiveTools(['mcp_call', 'mcp_list_tools'])
  } catch {
    /* 运行时未就绪则跳过 */
  }
}
