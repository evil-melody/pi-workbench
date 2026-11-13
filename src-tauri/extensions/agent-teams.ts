/**
 * Pi extension: 多智能体团队（agent-teams）
 *
 * 协调器调度多名专家完成多步任务。本仓不引入外部平台的协调器实现，
 * 只把「创建团队 / 调度 / 状态」对象化为 Pi 工具：
 *   · team_create    定义团队（成员 + 牵头人 + 协调策略 + 失败处理）
 *   · team_dispatch  把任务分派给各成员：有 pi 时隔离跑成员产出，否则返回结构化计划
 *   · team_status    查看团队定义与历史调度日志
 * 执行模型：成员键 `e:<expertId>` 会读该专家定义，注入四段式人格并设 `PI_EXPERT_ID`，
 * 让成员子进程沿用同一套工具门与专家审计；sequential 由牵头人先出计划再按序交接，
 * parallel/debate 由牵头人最后汇总；成员失败按 stop / continue / retry 处理。
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
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

type ToolResult = { content: string; details?: unknown; terminate?: boolean }
type TeamDef = {
  id: string
  name: string
  members: string[]
  strategy: string
  /** 牵头人：成员之一。旧团队没有该字段时按第一位处理。 */
  lead?: string
  /** 成员失败策略：stop 停止后续 / continue 继续 / retry 重试一次再按 stop 处理。 */
  on_failure?: 'stop' | 'continue' | 'retry'
  max_retries?: number
  created_at: number
}
type MemberResult = { member: string; ok: boolean; output: string; cancelled?: boolean }

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
function cancelPath(id: string): string {
  return path.join(teamsDir(), `${id}.cancel`)
}

/**
 * 取消请求：Rust 面板写 `<id>.cancel`（带 runId），成员子进程跑动中轮询这个文件。
 * 只认本次 runId（或空 runId 的通配请求），避免上一次的残留标记误伤新运行。
 */
function cancelRequested(id: string, runId: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(cancelPath(id), 'utf8'))
    return !raw?.runId || raw.runId === runId
  } catch {
    return false
  }
}

function clearCancel(id: string): void {
  try {
    unlinkSync(cancelPath(id))
  } catch {
    /* 没有标记文件是常态 */
  }
}

function readDef(id: string): TeamDef | null {
  try {
    return JSON.parse(readFileSync(defPath(id), 'utf8')) as TeamDef
  } catch {
    return null
  }
}

/** 成员键：`e:<expertId>` / `s:<skill>` / `c:<connectorId>`；旧团队存的是纯标签。 */
function expertDefinition(expertId: string): any | null {
  const base = process.env.PI_CODING_AGENT_DIR
  if (!base) return null
  for (const file of [`${expertId}.draft.json`, `${expertId}.published.json`]) {
    try {
      const raw = JSON.parse(readFileSync(path.join(base, 'experts', file), 'utf8'))
      if (raw?.definition) return raw.definition
    } catch {
      /* 换下一个文件 */
    }
  }
  return null
}

function expertIdOf(member: string): string | null {
  return member.startsWith('e:') ? member.slice(2) : null
}

function memberLabel(member: string): string {
  const expertId = expertIdOf(member)
  if (expertId) return expertDefinition(expertId)?.name || expertId
  return member.replace(/^[sc]:/, '')
}

/** 把专家四段式人格拼成成员提示词前缀：成员真的按这个专家说话，而不只是挂个名字。 */
function expertPersona(expertId: string | null): string {
  if (!expertId) return ''
  const def = expertDefinition(expertId)
  if (!def) return ''
  const parts = [
    def.role && `## 角色定位\n${def.role}`,
    def.methodology && `## 工作方法\n${def.methodology}`,
    def.boundaries && `## 行为边界\n${def.boundaries}`,
    def.deliverables && `## 交付物\n${def.deliverables}`,
    def.stop_condition && `## 停止条件\n${def.stop_condition}`,
  ].filter(Boolean)
  return parts.length ? `\n\n${parts.join('\n\n')}` : ''
}

function listTeams(): TeamDef[] {
  if (!existsSync(teamsDir())) return []
  return readdirSync(teamsDir())
    // 同目录还有 <id>-blackboard.json（成员产出数组），不是团队定义，必须排除；
    // 已删除团队改名 <id>.deleted.json，只保留运行日志供历史查询，不能再被调度。
    .filter(
      (f) =>
        f.endsWith('.json') &&
        !f.endsWith('-blackboard.json') &&
        !f.endsWith('.deleted.json'),
    )
    .map((f) => readDef(f.replace(/\.json$/, '')))
    .filter(
      (d): d is TeamDef =>
        d !== null && typeof d.id === 'string' && d.id !== '' && Array.isArray(d.members),
    )
}

/** 团队里引用了已删除专家的成员：调度前拦下，避免悄悄少人格、少策略。 */
function danglingExperts(def: TeamDef): string[] {
  const ids = def.members
    .map(expertIdOf)
    .filter((id): id is string => !!id && !expertDefinition(id))
  return Array.from(new Set(ids))
}

/** 真实调度次数：一次 dispatch 写一条 run_end（plan-only 写 note）。 */
function dispatchCount(id: string): number {
  if (!existsSync(logPath(id))) return 0
  return readFileSync(logPath(id), 'utf8')
    .split('\n')
    .filter(Boolean)
    .filter((line) => {
      try {
        const e = JSON.parse(line)
        return e?.type === 'run_end' || e?.note === 'plan-only'
      } catch {
        return false
      }
    }).length
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
  runId: string,
): Promise<MemberResult> {
  const provider = process.env.PI_LAUNCH_PROVIDER
  const model = process.env.PI_LAUNCH_MODEL
  const cwd = process.cwd()

  const boardText = board.length
    ? board.map((b) => `【${memberLabel(b.member)}】${b.ok ? '' : '(未产出) '}${b.output}`).join('\n\n')
    : ''
  const expertId = expertIdOf(member)
  const label = memberLabel(member)
  const roleLine = `你是团队「${def.name}」的成员「${label}」。（协调策略：${def.strategy}）`
  const boardLine = boardText
    ? `\n\n# 团队黑板（其他成员的产出，供你参考 / 反驳 / 补充）\n${boardText}`
    : ''
  const prompt = `${roleLine}${expertPersona(expertId)}\n任务：${task}${boardLine}\n请给出你的产出（结论优先，附关键依据）。`

  return new Promise<MemberResult>((resolve) => {
    const args = ['--mode', 'chat']
    if (provider) args.push('--provider', provider)
    if (model) args.push('--model', model)
    // 不传 --api-key：argv 对本机其他用户可见。成员继承内核对进程的环境
    // （PI_CODING_AGENT_DIR + PI_LAUNCH_API_KEY），按 models.json 条目取密钥。
    // PI_EXPERT_ID 让工具门按该专家的 allowed_tools / denied_patterns 拦截，复用同一套闸门与审计。
    // 显式写 PI_EXPERT_ID：非专家成员写空串，表示「本进程没有专家策略」，
    // 工具门据此不再回落到项目级策略文件（否则会继承交互运行留下的限制）。
    const env = { ...process.env, PI_EXPERT_ID: expertId ?? '' }

    // maxBuffer 只属于 exec/execFile；spawn 不认这个选项，传了会让重载解析失败。
    let child: ChildProcess
    try {
      child = spawn('pi', args, {
        cwd,
        env,
        timeout: MEMBER_TIMEOUT_MS,
      })
    } catch (e: any) {
      resolve({ member, ok: false, output: `spawn 失败：${String(e?.message ?? e)}` })
      return
    }

    let out = ''
    let err = ''
    let settled = false
    // 取消轮询：Rust 面板的取消请求落成文件，成员进程必须真的被杀掉，
    // 不能只把记录写成「已取消」而让子进程继续跑。
    let cancelTimer: ReturnType<typeof setInterval> | undefined
    const stopCancelWatch = () => {
      if (cancelTimer) {
        clearInterval(cancelTimer)
        cancelTimer = undefined
      }
    }
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
      stopCancelWatch()
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

    cancelTimer = setInterval(() => {
      if (!cancelRequested(def.id, runId)) return
      try {
        child.kill('SIGKILL')
      } catch {
        /* 进程可能刚好自行退出 */
      }
      // 已产出的部分要留在记录里：取消不是失败，也不是「什么都没有」。
      const partial = out.trim()
      finish({
        member,
        ok: false,
        cancelled: true,
        output: partial ? `（已取消）已产出部分：\n${partial}` : '（已取消，尚无产出）',
      })
    }, 400)

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
): Promise<{
  results: MemberResult[]
  lines: string[]
  runId: string
  aborted: boolean
  cancelled: boolean
}> {
  const runId = randomUUID().slice(0, 8)
  const results: MemberResult[] = []
  const lines: string[] = []
  const appendLog = (entry: unknown) =>
    appendFileSync(logPath(def.id), JSON.stringify(entry) + '\n', 'utf8')

  const lead = def.lead && def.members.includes(def.lead) ? def.lead : def.members[0]
  const others = def.members.filter((m) => m !== lead)
  const policy = def.on_failure ?? 'stop'
  // 重试次数封顶 3：避免一条坏命令把整支团队拖死。
  const maxRetries = Math.max(0, Math.min(def.max_retries ?? 1, 3))
  // retry 是「重试后仍失败就停」，不是「失败后继续」；重试耗尽与 stop 同义。
  const stopOnFailure = policy === 'stop' || policy === 'retry'
  let aborted = false
  let cancelled = false
  // 本次运行是否被面板请求取消：只认本 runId 的标记，开跑前先清掉上一次的残留。
  const isCancelled = () => cancelRequested(def.id, runId)
  clearCancel(def.id)
  // run_start 让「运行中 / 已结束」有明确起点，不再依赖第一条成员事件。
  appendLog({
    runId,
    type: 'run_start',
    team: def.name,
    strategy: def.strategy,
    lead,
    members: def.members,
    at: Date.now(),
  })

  if (!useReal) {
    for (const m of [lead, ...others]) {
      results.push({ member: m, ok: false, output: '（计划）待执行：本机无 pi，由协调器/用户按提示运行' })
      lines.push(`【${memberLabel(m)}】${m === lead ? '(牵头) ' : ''}（计划）任务：${task}`)
    }
    appendLog({ runId, note: 'plan-only', strategy: def.strategy, lead, at: Date.now() })
    return { results, lines, runId, aborted, cancelled }
  }

  /** 跑一名成员：记 start / end（含耗时、尝试次数），失败按策略决定是否重试。 */
  const runOne = async (
    member: string,
    board: MemberResult[],
    round?: number,
  ): Promise<MemberResult> => {
    // 取消后不再起新成员：已排队的成员直接记「已取消」，不 spawn。
    if (isCancelled()) {
      const skipped: MemberResult = { member, ok: false, cancelled: true, output: '（已取消，未开始）' }
      appendLog({
        runId,
        type: 'member_end',
        member,
        label: memberLabel(member),
        lead: member === lead,
        ok: false,
        cancelled: true,
        round,
        output: skipped.output,
        at: Date.now(),
      })
      return skipped
    }
    appendLog({
      runId,
      type: 'member_start',
      member,
      label: memberLabel(member),
      lead: member === lead,
      round,
      at: Date.now(),
    })
    const started = Date.now()
    let result = await runMember(def, member, task, board, runId)
    let attempts = 0
    while (!result.ok && !result.cancelled && policy === 'retry' && attempts < maxRetries) {
      attempts += 1
      appendLog({ runId, type: 'member_retry', member, round, attempt: attempts, at: Date.now() })
      result = await runMember(def, member, task, board, runId)
    }
    appendLog({
      runId,
      type: 'member_end',
      member,
      label: memberLabel(member),
      ok: result.ok,
      cancelled: !!result.cancelled,
      attempts,
      // 辩论策略同一成员会跑多轮，轮次必须落到记录里，否则运行记录读不出上下文。
      round,
      duration_ms: Date.now() - started,
      output: result.output.slice(0, 2000),
      at: Date.now(),
    })
    return result
  }

  const runGroup = (members: string[], board: MemberResult[], round?: number) =>
    Promise.all(members.map((m) => runOne(m, board, round)))

  if (def.strategy === 'parallel') {
    let board: MemberResult[] = []
    if (others.length) {
      const settled = await runGroup(others, board)
      results.push(...settled)
      board = [...board, ...settled]
      writeBoard(def.id, board)
      if (settled.some((r) => r.cancelled)) {
        cancelled = true
        aborted = true
        appendLog({ runId, type: 'run_aborted', reason: '已按请求取消运行', at: Date.now() })
      } else if (stopOnFailure && settled.some((r) => !r.ok)) aborted = true
      if (aborted && !cancelled) {
        appendLog({
          runId,
          type: 'run_aborted',
          reason: `成员失败，按 ${policy} 策略不再派发牵头汇总`,
          at: Date.now(),
        })
      }
    }
    // 牵头人最后汇总：parallel 下它看到的黑板才是完整产出。
    if (!aborted) {
      const leadRes = await runOne(lead, board)
      results.push(leadRes)
      if (leadRes.cancelled) {
        cancelled = true
        aborted = true
      }
    }
  } else if (def.strategy === 'debate') {
    // 有牵头人时它不参加互评轮，只在最后收敛；否则单成员团队自己跑两轮。
    const participants = others.length ? others : [lead]
    let board: MemberResult[] = []
    for (let round = 1; round <= 2; round++) {
      if (isCancelled()) {
        cancelled = true
        aborted = true
        break
      }
      const roundRes = await runGroup(participants, board, round)
      results.push(...roundRes)
      board = [...board, ...roundRes]
      writeBoard(def.id, board)
      appendLog({
        runId,
        type: 'round_summary',
        round,
        members: roundRes.map((r) => ({ member: r.member, ok: r.ok })),
        at: Date.now(),
      })
      if (roundRes.some((r) => r.cancelled)) {
        cancelled = true
        aborted = true
        appendLog({ runId, type: 'run_aborted', round, reason: '已按请求取消运行', at: Date.now() })
        break
      }
      if (stopOnFailure && roundRes.some((r) => !r.ok)) {
        aborted = true
        appendLog({
          runId,
          type: 'run_aborted',
          round,
          reason: `第 ${round} 轮有成员失败，按 ${policy} 策略停止后续轮次`,
          at: Date.now(),
        })
        break
      }
    }
    if (!aborted && others.length) {
      const leadRes = await runOne(lead, board)
      results.push(leadRes)
      if (leadRes.cancelled) {
        cancelled = true
        aborted = true
      }
    }
  } else {
    let board: MemberResult[] = []
    const order = [lead, ...others]
    for (let i = 0; i < order.length; i++) {
      if (isCancelled()) {
        cancelled = true
        aborted = true
        break
      }
      if (i > 0) {
        appendLog({ runId, type: 'handoff', from: order[i - 1], to: order[i], at: Date.now() })
      }
      const r = await runOne(order[i], board)
      results.push(r)
      board.push(r)
      writeBoard(def.id, board)
      if (r.cancelled) {
        cancelled = true
        aborted = true
        appendLog({ runId, type: 'run_aborted', reason: '已按请求取消运行', at: Date.now() })
        break
      }
      if (stopOnFailure && !r.ok) {
        aborted = true
        appendLog({
          runId,
          type: 'run_aborted',
          reason: `成员失败，按 ${policy} 策略停止后续交接`,
          at: Date.now(),
        })
        break
      }
    }
  }

  for (const r of results) {
    lines.push(`【${memberLabel(r.member)}】${r.member === lead ? '(牵头) ' : ''}${r.ok ? '' : r.cancelled ? '(已取消) ' : '(未跑通) '}${r.output.slice(0, 600)}`)
  }
  // 取消也写 run_end（带 cancelled），保证「调度次数」和历史收口口径一致；
  // 前端据 cancelled 显示「已取消」而不是失败。
  appendLog({
    runId,
    type: 'run_end',
    team: def.name,
    strategy: def.strategy,
    lead,
    on_failure: policy,
    real: true,
    aborted,
    cancelled,
    at: Date.now(),
  })
  clearCancel(def.id)
  return { results, lines, runId, aborted, cancelled }
}

export default function (pi: any) {
  pi.registerTool({
    name: 'team_create',
    label: '创建智能体团队',
    description: '定义一支多专家团队（成员列表 + 牵头人 + 协调策略 + 失败处理），返回团队 id',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '团队名称' },
        members: { type: 'array', items: { type: 'string' }, description: '成员（专家）名称列表' },
        lead: { type: 'string', description: '牵头人：必须是 members 之一，省略则取第一位' },
        strategy: {
          type: 'string',
          description: '协调策略：sequential（顺序）/ parallel（并行）/ debate（辩论）',
        },
        on_failure: {
          type: 'string',
          description: '成员失败处理：stop（停止后续）/ continue（继续）/ retry（重试一次）',
        },
      },
      required: ['name', 'members'],
      additionalProperties: false,
    },
    execute: async (_id: string, args: any): Promise<ToolResult> => {
      const name = String(args?.name ?? '').trim()
      const members: string[] = Array.isArray(args?.members)
        ? Array.from(new Set(args.members.map(String).map((s: string) => s.trim()).filter(Boolean)))
        : []
      const strategy = ['sequential', 'parallel', 'debate'].includes(args?.strategy)
        ? args.strategy
        : 'sequential'
      if (!name) return { content: 'name 不能为空', terminate: false }
      if (members.length < 1) return { content: 'members 至少 1 个', terminate: false }
      const lead = String(args?.lead ?? '').trim() || members[0]
      if (!members.includes(lead)) return { content: 'lead 必须是 members 之一', terminate: false }
      const on_failure = ['stop', 'continue', 'retry'].includes(args?.on_failure)
        ? (args.on_failure as TeamDef['on_failure'])
        : 'stop'
      const def: TeamDef = {
        id: randomUUID().slice(0, 8),
        name,
        members,
        lead,
        strategy,
        on_failure,
        created_at: Date.now(),
      }
      mkdirSync(teamsDir(), { recursive: true })
      writeFileSync(defPath(def.id), JSON.stringify(def, null, 2), 'utf8')
      return {
        content: `已创建团队「${name}」（id=${def.id}，成员 ${members.length}，牵头 ${memberLabel(lead)}，策略 ${strategy}，失败处理 ${on_failure}）`,
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
      if (!Array.isArray(def.members) || def.members.length === 0) {
        return { content: `团队 ${id} 没有成员，无法调度`, terminate: false }
      }
      // 悬空引用必须显式中断：否则成员会少人格、工具门拿不到策略，属于静默降级。
      const dangling = danglingExperts(def)
      if (dangling.length) {
        return {
          content: `团队成员引用的专家已不存在：${dangling.join('、')}。请先在能力中心恢复或重建这些专家，或编辑团队移除对应成员后再调度。`,
          details: { dangling, team: def },
          terminate: false,
        }
      }

      const useReal = await hasPi()
      // def 在这里读一次就固定下来：运行中编辑团队只改磁盘定义，不影响这趟调度。
      const { results, lines, runId, aborted, cancelled } = await dispatch(def, task, useReal)

      const tail = cancelled
        ? '已按请求取消运行，已产出的部分保留在运行记录里。'
        : aborted
          ? '有成员失败，已按停止策略中断后续交接。'
          : ''
      const summary = useReal
        ? `已调度团队「${def.name}」（${def.strategy}，牵头 ${memberLabel(def.lead ?? def.members[0])}），${results.length} 名成员产出见下。${tail}`
        : `本机无 pi，返回调度计划（${def.strategy}）。在装有 pi 的环境运行 team_dispatch 会真实跑成员产出。`
      return {
        content: `${summary}\n${lines.join('\n')}`,
        details: { run_id: runId, real: useReal, aborted, cancelled, results },
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
      return {
        content: `团队「${def.name}」\n成员：${def.members.map(memberLabel).join(', ')}\n牵头：${memberLabel(def.lead ?? def.members[0])}\n策略：${def.strategy}\n失败处理：${def.on_failure ?? 'stop'}\n调度次数：${dispatchCount(id)}`,
        details: { def, dispatches: dispatchCount(id), dangling: danglingExperts(def) },
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
