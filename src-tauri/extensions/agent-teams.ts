/**
 * Pi extension: 多智能体团队（agent-teams）
 *
 * 协调器调度多名专家完成多步任务。本仓不引入外部平台的协调器实现，
 * 只把「创建团队 / 调度 / 状态」对象化为 Pi 工具：
 *   · team_create    定义团队（成员 + 协调策略）
 *   · team_dispatch  把任务分派给各成员：若本机有 `pi` 则隔离跑一轮成员产出，
 *                     否则返回结构化调度计划（不报错，等协调器/用户执行）
 *   · team_status    查看团队定义与历史调度日志
 * 状态落 `<base>/.pi/teams/<id>.json`（定义）与 `<id>.jsonl`（运行日志），
 * 与 Rust `agent_teams_list` 共用。
 *
 * 边界（见 docs/AGENT-OPS.md §B）：真实 sub-agent 隔离与流式回填列入 B 期；
 * 本轮的 dispatch 是首轮骨架，依赖 `pi` 子进程且带超时保护，绝不让内核卡死。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

type ToolResult = { content: string; details?: unknown; terminate?: boolean }
type TeamDef = { id: string; name: string; members: string[]; strategy: string; created_at: number }

function piHome(): string {
  return process.env.PI_CODING_AGENT_DIR ?? process.cwd()
}
function teamsDir(): string {
  return path.join(piHome(), '.pi', 'teams')
}
function defPath(id: string): string {
  return path.join(teamsDir(), `${id}.json`)
}
function logPath(id: string): string {
  return path.join(teamsDir(), `${id}.jsonl`)
}

function readDef(id: string): TeamDef | null {
  try {
    return JSON.parse(readFileSync(defPath(id), 'utf8')) as TeamDef
  } catch {
    return null
  }
}

function listTeams(): TeamDef[] {
  if (!existsSync(teamsDir())) return []
  return readdirSync(teamsDir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => readDef(f.replace(/\.json$/, '')))
    .filter((d): d is TeamDef => d !== null)
}

/** 隔离跑一轮成员产出：仅当本机有 `pi` 时尝试，带超时保护，任何失败都回退到计划。 */
function runMember(def: TeamDef, member: string, task: string): { ok: boolean; output: string } {
  const prompt = `你是团队「${def.name}」的成员「${member}」。\n任务：${task}\n请给出你的产出（结论优先，附关键依据）。`
  try {
    const r = spawnSync('pi', ['--mode', 'chat'], {
      input: prompt,
      timeout: 90_000,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    })
    const out = (r.stdout ?? '').trim()
    if (r.status === 0 && out) return { ok: true, output: out }
    return { ok: false, output: `退出码 ${r.status}：${String(r.stderr ?? '').slice(0, 200)}` }
  } catch (e: any) {
    return { ok: false, output: String(e?.message ?? e) }
  }
}

export default function (pi: any) {
  pi.registerTool({
    name: 'team_create',
    label: '创建智能体团队',
    description: '定义一支多专家团队（成员列表 + 协调策略），返回团队 id',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '团队名称' },
        members: { type: 'array', items: { type: 'string' }, description: '成员（专家）名称列表' },
        strategy: {
          type: 'string',
          description: '协调策略：sequential（顺序）/ parallel（并行）/ debate（辩论）',
        },
      },
      required: ['name', 'members'],
      additionalProperties: false,
    },
    execute: async (_id: string, args: any): Promise<ToolResult> => {
      const name = String(args?.name ?? '').trim()
      const members = Array.isArray(args?.members) ? args.members.map(String) : []
      const strategy = ['sequential', 'parallel', 'debate'].includes(args?.strategy)
        ? args.strategy
        : 'sequential'
      if (!name) return { content: 'name 不能为空', terminate: false }
      if (members.length < 1) return { content: 'members 至少 1 个', terminate: false }
      const def: TeamDef = {
        id: randomUUID().slice(0, 8),
        name,
        members,
        strategy,
        created_at: Date.now(),
      }
      mkdirSync(teamsDir(), { recursive: true })
      writeFileSync(defPath(def.id), JSON.stringify(def, null, 2), 'utf8')
      return {
        content: `已创建团队「${name}」（id=${def.id}，成员 ${members.length}，策略 ${strategy}）`,
        details: def,
      }
    },
  })

  pi.registerTool({
    name: 'team_dispatch',
    label: '调度团队任务',
    description: '把任务分派给团队成员：有 pi 则隔离跑一轮成员产出，否则返回调度计划',
    parameters: {
      type: 'object',
      properties: {
        team_id: { type: 'string', description: 'team_create 返回的团队 id' },
        task: { type: 'string', description: '要分派的任务' },
      },
      required: ['team_id', 'task'],
      additionalProperties: false,
    },
    execute: async (_id: string, args: any): Promise<ToolResult> => {
      const id = String(args?.team_id ?? '').trim()
      const task = String(args?.task ?? '').trim()
      const def = readDef(id)
      if (!def) {
        return {
          content: `团队 ${id} 不存在`,
          details: { available: listTeams().map((t) => t.id) },
          terminate: false,
        }
      }
      if (!task) return { content: 'task 不能为空', terminate: false }

      const useReal = (() => {
        try {
          spawnSync('pi', ['--version'], { stdio: 'ignore', timeout: 5000 })
          return true
        } catch {
          return false
        }
      })()

      const runId = randomUUID().slice(0, 8)
      const results: { member: string; ok: boolean; output: string }[] = []
      const lines: string[] = []

      if (useReal) {
        for (const m of def.members) {
          const r = runMember(def, m, task)
          results.push({ member: m, ok: r.ok, output: r.output })
          lines.push(`【${m}】${r.ok ? '' : '(未跑通) '}${r.output.slice(0, 600)}`)
          appendFileSync(
            logPath(id),
            JSON.stringify({ runId, member: m, ok: r.ok, output: r.output, at: Date.now() }) + '\n',
            'utf8',
          )
        }
      } else {
        // 无 pi：返回结构化调度计划，不报错。
        for (const m of def.members) {
          results.push({ member: m, ok: false, output: '（计划）待执行：本机无 pi，由协调器/用户按提示运行' })
          lines.push(`【${m}】（计划）任务：${task}`)
        }
      }

      const stamp = { runId, team: def.name, strategy: def.strategy, real: useReal, at: Date.now() }
      appendFileSync(logPath(id), JSON.stringify(stamp) + '\n', 'utf8')

      const summary = useReal
        ? `已调度团队「${def.name}」（${def.strategy}），${results.length} 名成员产出见下。`
        : `本机无 pi，返回调度计划（${def.strategy}）。在装有 pi 的环境运行 team_dispatch 会真实跑成员产出。`
      return {
        content: `${summary}\n${lines.join('\n')}`,
        details: { runId, real: useReal, results },
      }
    },
  })

  pi.registerTool({
    name: 'team_status',
    label: '查看团队状态',
    description: '查看某团队的定义与历史调度日志',
    parameters: {
      type: 'object',
      properties: {
        team_id: { type: 'string', description: '团队 id' },
      },
      required: ['team_id'],
      additionalProperties: false,
    },
    execute: async (_id: string, args: any): Promise<ToolResult> => {
      const id = String(args?.team_id ?? '').trim()
      const def = readDef(id)
      if (!def) {
        return {
          content: `团队 ${id} 不存在`,
          details: { available: listTeams().map((t) => t.id) },
          terminate: false,
        }
      }
      const log = existsSync(logPath(id))
        ? readFileSync(logPath(id), 'utf8')
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .length
        : 0
      return {
        content: `团队「${def.name}」\n成员：${def.members.join(', ')}\n策略：${def.strategy}\n调度记录：${log} 条`,
        details: { def, log_lines: log },
      }
    },
  })

  pi.registerCommand('team', {
    description: '显示已创建的团队数量',
    handler: async (_arg: string, ctx: any) => {
      const teams = listTeams()
      ctx.ui?.notify(`team: ${teams.length} 支团队`, 'info')
    },
  })

  try {
    pi.setActiveTools(['team_create', 'team_dispatch', 'team_status'])
  } catch {
    /* 运行时未就绪则跳过 */
  }
}
