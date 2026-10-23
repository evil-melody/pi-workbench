/**
 * Pi extension: 多智能体团队（agent-teams）
 *
 * 协调器调度多名专家完成多步任务。本仓不引入外部平台的协调器实现，
 * 只把「创建团队 / 调度 / 状态」对象化为 Pi 工具：
 *   · team_create    定义团队（成员 + 协调策略）
 *   · team_dispatch  把任务分派给各成员：有 pi 时隔离跑成员产出，否则返回结构化计划
 *   · team_status    查看团队定义与历史调度日志
 * 状态落 `<base>/.pi/teams/<id>.json`（定义）、`<id>.jsonl`（运行日志）、
 * `<id>-blackboard.json`（团队黑板，成员间可见的产出沉淀），与 Rust `agent_teams_list` 共用。
 *
 * 对照 WORKDSH-ALIGN-26 的修复：
 *   · A1 调度不再阻塞内核——成员子进程走异步 `spawn` + 超时回收，事件循环不卡死。
 *   · A2 三种策略是真实分支：sequential 顺序、parallel 并发、debate 两轮互评收敛。
 *   · A3 成员子进程带 cwd（项目目录，使角色/黑板可见）、provider/model/api-key
 *       （读内核透传的 PI_LAUNCH_* 环境变量，避免用默认模型）、角色头与团队黑板。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  appendFileSync,
  writeFileSync,
} from 'node:fs'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

type ToolResult = { content: string; details?: unknown; terminate?: boolean }
type TeamDef = { id: string; name: string; members: string[]; strategy: string; created_at: number }
type MemberResult = { member: string; ok: boolean; output: string }

const MEMBER_TIMEOUT_MS = 90_000

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
function boardPath(id: string): string {
  return path.join(teamsDir(), `${id}-blackboard.json`)
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

/** 读取团队黑板：其他成员 / 上一轮已沉淀的产出，供当前成员参考或反驳。 */
function readBoard(id: string): MemberResult[] {
  try {
    const arr = JSON.parse(readFileSync(boardPath(id), 'utf8'))
    return Array.isArray(arr) ? (arr as MemberResult[]) : []
  } catch {
    return []
  }
}

/** 把当前黑板落盘：成员间共享，名字与 agent_ops 的 teams 目录同源。 */
function writeBoard(id: string, board: MemberResult[]): void {
  try {
    mkdirSync(teamsDir(), { recursive: true })
    writeFileSync(boardPath(id), JSON.stringify(board, null, 2), 'utf8')
  } catch {
    /* 黑板写入失败不阻断调度，仅丧失跨成员可见性 */
  }
}

/** 本机是否有可用 pi（异步探测，不阻塞内核）。 */
function hasPi(): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false
    let child
    try {
      child = spawn('pi', ['--version'], { stdio: 'ignore', timeout: 5000 })
    } catch {
      resolve(false)
      return
    }
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
      done(false)
    }, 5000)
    child.on('error', () => {
      clearTimeout(timer)
      done(false)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done(code === 0)
    })
  })
}

/**
 * 异步跑一名成员：spawn 非阻塞，超时（MEMBER_TIMEOUT_MS）回收进程。
 * 携带：项目 cwd、内核透传的 provider/model/api-key、角色头、团队黑板。
 */
function runMember(
  def: TeamDef,
  member: string,
  task: string,
  board: MemberResult[],
): Promise<MemberResult> {
  const provider = process.env.PI_LAUNCH_PROVIDER
  const model = process.env.PI_LAUNCH_MODEL
  const apiKey = process.env.PI_LAUNCH_API_KEY
  const cwd = process.cwd()

  const boardText = board.length
    ? board.map((b) => `【${b.member}】${b.ok ? '' : '(未产出) '}${b.output}`).join('\n\n')
    : ''
  const roleLine = `你是团队「${def.name}」的成员「${member}」。（协调策略：${def.strategy}）`
  const boardLine = boardText
    ? `\n\n# 团队黑板（其他成员的产出，供你参考 / 反驳 / 补充）\n${boardText}`
    : ''
  const prompt = `${roleLine}\n任务：${task}${boardLine}\n请给出你的产出（结论优先，附关键依据）。`

  return new Promise<MemberResult>((resolve) => {
    const args = ['--mode', 'chat']
    if (provider) args.push('--provider', provider)
    if (model) args.push('--model', model)
    if (apiKey && apiKey.trim()) args.push('--api-key', apiKey)

    let child
    try {
      child = spawn('pi', args, { cwd, timeout: MEMBER_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 })
    } catch (e: any) {
      resolve({ member, ok: false, output: `spawn 失败：${String(e?.message ?? e)}` })
      return
    }

    let out = ''
    let err = ''
    let settled = false
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString()
    })
    child.stderr?.on('data', (d: Buffer) => {
      err += d.toString()
    })

    const finish = (result: MemberResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
      finish({ member, ok: false, output: `成员「${member}」超时（>${MEMBER_TIMEOUT_MS / 1000}s）被回收` })
    }, MEMBER_TIMEOUT_MS)

    child.on('error', (e) => {
      finish({ member, ok: false, output: `成员「${member}」启动失败：${String(e?.message ?? e)}` })
    })
    child.on('close', (code) => {
      const trimmed = out.trim()
      if (code === 0 && trimmed) {
        finish({ member, ok: true, output: trimmed })
      } else {
        finish({ member, ok: false, output: `退出码 ${code}：${err.slice(0, 200) || '无输出'}` })
      }
    })

    try {
      child.stdin?.write(prompt)
      child.stdin?.end()
    } catch {
      /* stdin 写入失败由 close/error 兜底 */
    }
  })
}

/**
 * 按策略真实调度成员：
 *   sequential —— 顺序 await，逐步把黑板喂给后续成员；
 *   parallel   —— Promise.all 并发（无跨成员依赖）；
 *   debate     —— 两轮互评：第一轮独立产出，第二轮把第一轮黑板回灌做反驳/收敛。
 */
async function dispatch(
  def: TeamDef,
  task: string,
  useReal: boolean,
): Promise<{ results: MemberResult[]; lines: string[]; runId: string }> {
  const runId = randomUUID().slice(0, 8)
  const results: MemberResult[] = []
  const lines: string[] = []
  const appendLog = (entry: unknown) =>
    appendFileSync(logPath(def.id), JSON.stringify(entry) + '\n', 'utf8')

  if (!useReal) {
    for (const m of def.members) {
      results.push({ member: m, ok: false, output: '（计划）待执行：本机无 pi，由协调器/用户按提示运行' })
      lines.push(`【${m}】（计划）任务：${task}`)
    }
    appendLog({ runId, note: 'plan-only', strategy: def.strategy, at: Date.now() })
    return { results, lines, runId }
  }

  if (def.strategy === 'parallel') {
    const settled = await Promise.all(def.members.map((m) => runMember(def, m, task, [])))
    results.push(...settled)
  } else if (def.strategy === 'debate') {
    let board: MemberResult[] = []
    for (let round = 1; round <= 2; round++) {
      const roundRes = await Promise.all(def.members.map((m) => runMember(def, m, task, board)))
      results.push(...roundRes)
      board = [...board, ...roundRes]
      writeBoard(def.id, board)
      appendLog({
        runId,
        round,
        members: roundRes.map((r) => ({ member: r.member, ok: r.ok })),
        at: Date.now(),
      })
    }
  } else {
    let board: MemberResult[] = []
    for (const m of def.members) {
      const r = await runMember(def, m, task, board)
      results.push(r)
      board.push(r)
      writeBoard(def.id, board)
    }
  }

  for (const r of results) {
    lines.push(`【${r.member}】${r.ok ? '' : '(未跑通) '}${r.output.slice(0, 600)}`)
    appendLog({ runId, member: r.member, ok: r.ok, output: r.output, at: Date.now() })
  }
  appendLog({ runId, team: def.name, strategy: def.strategy, real: true, at: Date.now() })
  return { results, lines, runId }
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
    description: '把任务分派给团队成员：有 pi 则按策略真实跑成员产出，否则返回调度计划',
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

      const useReal = await hasPi()
      const { results, lines, runId } = await dispatch(def, task, useReal)

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
