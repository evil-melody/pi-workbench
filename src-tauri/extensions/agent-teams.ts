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
  /**
   * 人工关卡：这些成员开跑前必须有人放行（LoopForge human-gate 节点）。
   * 值是成员键；空数组 = 无人审。
   */
  gates?: string[]
  /**
   * 成员级执行器 / 模型覆盖：{ 成员键: { executor?, model? } }。
   * LoopForge 的「显式能力边界」：选了什么就真用什么，不悄悄换成默认执行器。
   */
  member_overrides?: Record<string, MemberOverride>
  created_at: number
}
/** 成员级执行配置覆盖。 */
type MemberOverride = { executor?: string; model?: string }
/** 人工关卡的放行决定。 */
type GateDecision = {
  runId: string
  member: string
  decision: 'approve' | 'reject'
  at: number
  note?: string
}
type MemberResult = {
  member: string
  ok: boolean
  output: string
  cancelled?: boolean
  /** 人工关卡未放行而跳过（区别于「跑失败」与「被取消」）。 */
  skipped?: boolean
  /** 本成员进程消耗的 token（从 Pi json 模式 message_end.usage 聚合）。 */
  tokens?: number
}

/**
 * 解析 Pi `--mode json` 的 stdout：逐行 JSON，取 assistant 的正文、usage 与错误。
 *
 * pi 0.87.1 的 wire 信封（docs/json.md 权威形状）：
 *   {"type":"message_update","usage":{…},"assistantMessageEvent":
 *     {"type":"text_delta","contentIndex":0,"delta":"Hello"}}
 * delta **嵌套**在 assistantMessageEvent 里，顶层只有累计 usage——早先按扁平
 * `ev.delta` 采集全部 miss，成员烧了几万 token 却判「无输出」，stop 策略直接
 * 中断全队（2026-11-22 生产日志实证）。text_end 带整块权威 content，用它
 * 替换累计的 delta；message_end.message 是最终完整消息，收编后清空流式缓冲，
 * 避免与 delta 重复计文。
 *
 * 另一个坑：pi json 模式下错误轮（429 / 鉴权 / 网络）content 为空但**退出码
 * 仍是 0**（print-mode.js 的 exitCode=1 只走 text 分支），必须在解析层把
 * errorMessage 透出来，否则诊断只剩误导性的「退出码 0：无输出」。
 *
 * 老版本若只输出纯文本（非 JSON 行），原样返回当文本，tokens 缺失。
 */
export function parseMemberOutput(raw: string): { text: string; tokens: number; error?: string } {
  let tokens = 0
  /** message_end 收编的定稿文本，按消息顺序。 */
  const done: string[] = []
  /** 当前 assistant 消息的流式缓冲：contentIndex → 文本（未定稿，取消/断流时是 partial）。 */
  const live = new Map<number, string>()
  let sawJson = false
  let error: string | undefined
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s.startsWith('{')) continue
    let ev: any
    try {
      ev = JSON.parse(s)
    } catch {
      continue
    }
    sawJson = true
    const u = ev?.usage ?? ev?.message?.usage ?? ev?.message_end?.usage
    if (typeof u?.totalTokens === 'number') tokens = Math.max(tokens, u.totalTokens)
    else if (typeof u?.total === 'number') tokens = Math.max(tokens, u.total)
    if (ev?.type === 'message_end') {
      const msg = ev?.message_end?.message ?? ev?.message
      if (msg?.role === 'assistant') {
        if (msg?.stopReason === 'error' && msg?.errorMessage) error = String(msg.errorMessage)
        const parts = Array.isArray(msg?.content) ? msg.content : []
        for (const p of parts) if (p?.type === 'text' && typeof p.text === 'string') done.push(p.text)
        // 定稿即权威：流式缓冲里同一条消息的内容不再重复计入。
        live.clear()
      }
    } else if (ev?.type === 'message_update') {
      const ame = ev?.assistantMessageEvent
      if (ame && typeof ame === 'object') {
        const idx = typeof ame.contentIndex === 'number' ? ame.contentIndex : 0
        if (ame.type === 'text_delta' && typeof ame.delta === 'string') {
          live.set(idx, (live.get(idx) ?? '') + ame.delta)
        } else if (ame.type === 'text_end' && typeof ame.content === 'string') {
          live.set(idx, ame.content)
        }
      }
      // 没有 assistantMessageEvent 包装的 message_update（thinking/toolcall 之外的
      // 生命周期行）没有正文可取，跳过。
    }
  }
  if (!sawJson) return { text: raw.trim(), tokens: 0 }
  const streaming = [...live.keys()]
    .sort((a, b) => a - b)
    .map((k) => live.get(k)!)
    .join('')
  const text = [...done, streaming].join('').trim()
  return error ? { text, tokens, error } : { text, tokens }
}

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
/** 追加一行运行日志（模块级：dispatch 与 team_replay 共用一份写法）。 */
function appendRunLog(id: string, entry: unknown): void {
  appendFileSync(logPath(id), JSON.stringify(entry) + '\n', 'utf8')
}
function boardPath(id: string): string {
  return path.join(teamsDir(), `${id}-blackboard.json`)
}
function cancelPath(id: string): string {
  return path.join(teamsDir(), `${id}.cancel`)
}
/** 待放行的人工关卡（扩展写，面板读）。按成员分文件：并行策略下多个成员可能同时等放行。 */
function gatePath(id: string, member: string): string {
  return path.join(teamsDir(), `${id}.gate.${gateKey(member)}.json`)
}
/** 面板写回的人工关卡决定（扩展读）。 */
function gateDecisionPath(id: string, member: string): string {
  return path.join(teamsDir(), `${id}.gate.${gateKey(member)}.decision.json`)
}
/** 成员键 → 文件名安全串。同名成员（不同 key）再加短哈希防撞。 */
function gateKey(member: string): string {
  const safe = member.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)
  let hash = 0
  for (const ch of member) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return `${safe}_${hash.toString(36)}`
}

/**
 * 反废话纪律：从环境变量读，文本真源在 Rust 的 agent_style 模块。
 *
 * 为什么走环境变量而不是在本文件里再写一份：这段文本在 Rust 派发外部 CLI 时
 * 也会用，两处各写一份必然漂移。Rust 启内核时注入 PI_AGENT_TERSE，
 * 扩展读它拼进每个成员子进程的提示词。
 */
function terseDirective(): string {
  const raw = process.env.PI_AGENT_TERSE?.trim()
  return raw ? `\n\n${raw}` : ''
}

/** 人工关卡等待上限：10 分钟。超时按驳回处理，不无限挂起整支团队。 */
const GATE_TIMEOUT_MS = 600_000

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
    // LoopForge 硬规则：专家声明的规则必须在成员子进程里真生效，不能只停在提示词预览。
    typeof def.rules === 'string' && def.rules.trim() && `## 硬规则\n${def.rules.trim()}`,
  ].filter(Boolean)
  return parts.length ? `\n\n${parts.join('\n\n')}` : ''
}

/**
 * 执行器解析：成员覆盖 > 专家定义 > 默认 pi。
 *
 * LoopForge 的「显式能力边界」：角色写死用什么执行器，调度端就真用什么，
 * 不会因为默认是 pi 就把 claude 的角色悄悄换成 pi。这里把最终选择回传给
 * 面板显示，让用户看得见「谁在什么执行器上跑」。
 */
function executorOf(
  def: TeamDef,
  member: string,
): { exec: string; model?: string; source: 'override' | 'expert' | 'default' } {
  const override = def.member_overrides?.[member]
  const expertId = expertIdOf(member)
  const expertDef = expertId ? expertDefinition(expertId) : null
  const overrideExec = override?.executor?.trim()
  const expertExec = typeof expertDef?.executor === 'string' ? expertDef.executor.trim() : ''
  const exec = overrideExec || expertExec || 'pi'
  const source: 'override' | 'expert' | 'default' = overrideExec
    ? 'override'
    : expertExec
      ? 'expert'
      : 'default'
  const overrideModel = override?.model?.trim()
  const expertModel = typeof expertDef?.model === 'string' ? expertDef.model.trim() : ''
  const model = overrideModel || expertModel || undefined
  return { exec, model, source }
}

/** 等待人工放行：扩展写待审，面板写决定。返回 approve / reject / timeout。 */
async function awaitGate(
  def: TeamDef,
  member: string,
  runId: string,
): Promise<'approve' | 'reject' | 'timeout'> {
  mkdirSync(teamsDir(), { recursive: true })
  writeFileSync(
    gatePath(def.id, member),
    JSON.stringify(
      { runId, member, label: memberLabel(member), team: def.name, at: Date.now() },
      null,
      2,
    ),
    'utf8',
  )
  const deadline = Date.now() + GATE_TIMEOUT_MS
  while (Date.now() < deadline) {
    // 运行被取消时不等关卡：否则面板已取消、扩展还在等放行，双方对不上。
    if (cancelRequested(def.id, runId)) {
      try {
        unlinkSync(gatePath(def.id, member))
      } catch {
        /* ignore */
      }
      return 'reject'
    }
    try {
      const raw = JSON.parse(
        readFileSync(gateDecisionPath(def.id, member), 'utf8'),
      ) as GateDecision
      if (raw?.runId === runId && raw?.member === member) {
        try {
          unlinkSync(gateDecisionPath(def.id, member))
        } catch {
          /* ignore */
        }
        try {
          unlinkSync(gatePath(def.id, member))
        } catch {
          /* ignore */
        }
        return raw.decision === 'approve' ? 'approve' : 'reject'
      }
    } catch {
      /* 还没决定 */
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  try {
    unlinkSync(gatePath(def.id, member))
  } catch {
    /* ignore */
  }
  return 'timeout'
}

function listTeams(): TeamDef[] {  if (!existsSync(teamsDir())) return []
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

/** 读取调度日志里的运行列表（按出现顺序）：重放要靠它找到目标任务原文。 */
function readRuns(id: string): Array<{ runId: string; task?: string }> {
  if (!existsSync(logPath(id))) return []
  const out: Array<{ runId: string; task?: string }> = []
  for (const line of readFileSync(logPath(id), 'utf8').split('\n').filter(Boolean)) {
    try {
      const e = JSON.parse(line)
      if (e?.type !== 'run_start') continue
      out.push({ runId: String(e.runId ?? ''), task: typeof e.task === 'string' ? e.task : undefined })
    } catch {
      /* 坏行跳过 */
    }
  }
  return out
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
  // 反废话纪律必带：多 agent 并行时，每句废话乘以成员数就是成倍 token 浪费。
  const prompt = `${roleLine}${expertPersona(expertId)}\n任务：${task}${boardLine}\n请给出你的产出（结论优先，附关键依据）。${terseDirective()}`

  const { exec, model } = executorOf(def, member)
  // 各执行器的调用形态不同：pi 走 stdin（避免密钥与长提示进 argv），其余走参数。
  const buildArgs = (): string[] => {
    if (exec === 'claude') {
      const a = ['-p']
      if (model) a.push('--model', model)
      a.push(prompt)
      return a
    }
    if (exec === 'codex') {
      const a = ['exec']
      if (model) a.push('-m', model)
      a.push(prompt)
      return a
    }
    // 合法模式是 text / json / rpc（实测 pi 无 chat 模式）。用 json 才能在
    // 成员产出里带上 message_end.usage —— 团队成本汇总的唯一 token 来源。
    const a = ['--mode', 'json']
    const p = model ?? process.env.PI_LAUNCH_MODEL
    const prov = process.env.PI_LAUNCH_PROVIDER
    if (prov) a.push('--provider', prov)
    if (p) a.push('--model', p)
    return a
  }
  const stdinMode = exec !== 'claude' && exec !== 'codex'

  return new Promise<MemberResult>((resolve) => {
    const args = buildArgs()
    // 不传 --api-key：argv 对本机其他用户可见。成员继承内核对进程的环境
    // （PI_CODING_AGENT_DIR + PI_LAUNCH_API_KEY），按 models.json 条目取密钥。
    // PI_EXPERT_ID 让工具门按该专家的 allowed_tools / denied_patterns 拦截，复用同一套闸门与审计。
    // 显式写 PI_EXPERT_ID：非专家成员写空串，表示「本进程没有专家策略」，
    // 工具门据此不再回落到项目级策略文件（否则会继承交互运行留下的限制）。
    const env = { ...process.env, PI_EXPERT_ID: expertId ?? '' }

    // maxBuffer 只属于 exec/execFile；spawn 不认这个选项，传了会让重载解析失败。
    let child: ChildProcess
    try {
      child = spawn(exec, args, {
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
      const partialParsed = stdinMode ? parseMemberOutput(out) : null
      const partial = partialParsed?.text ?? out.trim()
      finish({
        member,
        ok: false,
        cancelled: true,
        output: partial ? `（已取消）已产出部分：\n${partial}` : '（已取消，尚无产出）',
        tokens: partialParsed?.tokens ?? 0,
      })
    }, 400)

    child.on('error', (e) => {
      finish({ member, ok: false, output: `成员「${member}」启动失败：${String(e?.message ?? e)}` })
    })
    child.on('close', (code) => {
      // pi 走 json 模式：事件流要解析成正文 + token；其余执行器仍是纯文本。
      const parsed = stdinMode
        ? parseMemberOutput(out)
        : { text: out.trim(), tokens: 0, error: undefined as string | undefined }
      if (code === 0 && parsed.text) {
        finish({ member, ok: true, output: parsed.text, tokens: parsed.tokens })
      } else {
        // json 模式下错误轮（429/鉴权）退出码仍是 0：真因在流里，不在 stderr。
        const why = parsed.error || err.slice(0, 200) || '无输出'
        finish({ member, ok: false, output: `退出码 ${code}：${why}`, tokens: parsed.tokens })
      }
    })

    try {
      // pi 走 stdin：提示词可能很长，进 argv 会撑爆命令行长度上限，
      // 也会被同机其他用户的 ps 看到。claude / codex 的无头模式只接受位置参数。
      if (stdinMode) {
        child.stdin?.write(prompt)
        child.stdin?.end()
      }
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
  runId = randomUUID().slice(0, 8),
): Promise<{
  results: MemberResult[]
  lines: string[]
  runId: string
  aborted: boolean
  cancelled: boolean
}> {
  const results: MemberResult[] = []
  const lines: string[] = []
  const appendLog = (entry: unknown) => appendRunLog(def.id, entry)

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
    // 任务原文落进日志：节点级重放要靠它重跑单个成员。
    task: task.slice(0, 4000),
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
    // 人工关卡（LoopForge human-gate）：配置了关卡的成员必须有人放行才开跑。
    if ((def.gates ?? []).includes(member)) {
      appendLog({
        runId,
        type: 'gate_pending',
        member,
        label: memberLabel(member),
        round,
        at: Date.now(),
      })
      const decision = await awaitGate(def, member, runId)
      appendLog({
        runId,
        type: 'gate_decision',
        member,
        label: memberLabel(member),
        decision,
        round,
        at: Date.now(),
      })
      if (decision !== 'approve') {
        const note =
          decision === 'timeout' ? '（人工关卡超时未放行，未执行）' : '（人工关卡驳回，未执行）'
        const blocked: MemberResult = { member, ok: false, skipped: true, output: note }
        appendLog({
          runId,
          type: 'member_end',
          member,
          label: memberLabel(member),
          ok: false,
          skipped: true,
          round,
          output: note,
          at: Date.now(),
        })
        return blocked
      }
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
      tokens: result.tokens ?? 0,
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
        gates: {
          type: 'array',
          items: { type: 'string' },
          description: '人工关卡成员：这些成员开跑前必须有人放行（LoopForge human-gate）',
        },
        member_overrides: {
          type: 'object',
          description: '成员级执行器 / 模型覆盖，如 { "e:reviewer": { "executor": "claude" } }',
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
      // 人工关卡只允许指向真实成员：写了不存在的成员，关卡永远不会触发。
      const gates: string[] = Array.isArray(args?.gates)
        ? args.gates.map(String).filter((g: string) => members.includes(g))
        : []
      const member_overrides: Record<string, MemberOverride> = {}
      if (args?.member_overrides && typeof args.member_overrides === 'object') {
        for (const [key, raw] of Object.entries(args.member_overrides as Record<string, any>)) {
          if (!members.includes(key) || !raw || typeof raw !== 'object') continue
          const entry: MemberOverride = {}
          if (typeof raw.executor === 'string' && raw.executor.trim()) entry.executor = raw.executor.trim()
          if (typeof raw.model === 'string' && raw.model.trim()) entry.model = raw.model.trim()
          if (entry.executor || entry.model) member_overrides[key] = entry
        }
      }
      const def: TeamDef = {
        id: randomUUID().slice(0, 8),
        name,
        members,
        lead,
        strategy,
        on_failure,
        gates,
        member_overrides,
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

  /**
   * 同一 (团队, 任务) 短窗口内只派一次：模型在工具报错后反复重试会 spawn 出
   * 几十个成员子进程（2026-11-22 截图：bash×93 / team_dispatch×3 / 96 步）。
   * 幂等命中时返回第一次的 run_id，不再起新进程——重放请看面板的历史运行。
   */
  const dispatchDedupe = new Map<string, { runId: string; at: number }>()
  const DEDUPE_MS = 60_000

  /** 工具与 `/team dispatch` 命令共用同一条调度路径，避免两处防线漂移。 */
  async function dispatchTeam(rawId: unknown, rawTask: unknown): Promise<ToolResult> {
    let id = String(rawId ?? '').trim()
    const task = String(rawTask ?? '').trim()
    // 模型常只给 task、漏 team_id（截图红框 {"task":…} 即缺参校验失败 → 重试风暴）。
    // 单团队时直接兜底选它；多团队时选最近建的并说明，让模型一次就能成功。
    const teams = listTeams()
    if (!id && teams.length === 1) id = teams[0].id
    if (!task) return { content: 'task 不能为空', terminate: false }
    if (!id) {
      return {
        content: `缺少 team_id，本机有 ${teams.length} 个团队：${teams.map((t) => `${t.id}(${t.name})`).join('、')}。请带 team_id 重试一次。`,
        details: { available: teams.map((t) => t.id) },
        terminate: false,
      }
    }
    const def = readDef(id)
    if (!def) {
      return {
        content: `团队 ${id} 不存在`,
        details: { available: teams.map((t) => t.id) },
        terminate: false,
      }
    }
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

    // 幂等：窗口内重复调用（模型重试 / 用户连发）不重复起进程。
    const key = `${id}|${task}`
    const prior = dispatchDedupe.get(key)
    if (prior && Date.now() - prior.at < DEDUPE_MS) {
      return {
        content: `团队「${def.name}」已在运行 #${prior.runId} 处理同一任务，未重复派出。进度见「智能体」运行记录。`,
        details: { run_id: prior.runId, duplicate: true },
      }
    }

    const useReal = await hasPi()
    // 队长只派发、不阻塞主对话：成员是独立子进程，跑完由面板轮询日志展示。
    // runId 先生成，dispatch() 第一行同步写 run_start，返回时面板已显示运行中。
    const runId = randomUUID().slice(0, 8)
    dispatchDedupe.set(key, { runId, at: Date.now() })
    if (dispatchDedupe.size > 200) {
      const cutoff = Date.now() - DEDUPE_MS
      for (const [k, v] of dispatchDedupe) if (v.at < cutoff) dispatchDedupe.delete(k)
    }
    if (!useReal) {
      const { results, lines } = await dispatch(def, task, false, runId)
      return {
        content: `本机无 pi，返回调度计划（${def.strategy}）。在装有 pi 的环境运行 team_dispatch 会真实跑成员产出。\n${lines.join('\n')}`,
        details: { run_id: runId, real: false, results },
      }
    }
    void dispatch(def, task, true, runId).catch((e: unknown) => {
      appendRunLog(def.id, {
        runId,
        type: 'run_aborted',
        reason: String((e as { message?: unknown })?.message ?? e),
        at: Date.now(),
      })
    })
    return {
      content: `已派出团队「${def.name}」（${def.strategy}，牵头 ${memberLabel(def.lead ?? def.members[0])}），运行 #${runId} 已在后台启动。成员进度见「智能体」运行记录。`,
      details: { run_id: runId, real: true, async: true },
    }
  }

  pi.registerTool({
    name: 'team_dispatch',
    label: '调度团队任务',
    description: '把任务分派给团队成员：有 pi 则按策略真实跑成员产出，否则返回调度计划',
    parameters: {
      type: 'object',
      properties: {
        team_id: { type: 'string', description: '团队 id；只有一个团队时可省略，工具自动兜底' },
        task: { type: 'string', description: '要分派的任务' },
      },
      // team_id 不能 required：模型常只给 task，内核缺参校验会让 execute 根本没机会跑，
      // 模型看到「失败」就反复重试（实测 96 步）。兜底与报错交给 dispatchTeam。
      required: ['task'],
      additionalProperties: false,
    },
    execute: async (_id: string, args: any): Promise<ToolResult> =>
      dispatchTeam(args?.team_id, args?.task),
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
      const gateInfo = (def.gates ?? []).length
        ? `\n人工关卡：${(def.gates ?? []).map(memberLabel).join('、')}`
        : ''
      const overrideInfo = Object.keys(def.member_overrides ?? {}).length
        ? `\n执行器覆盖：${Object.entries(def.member_overrides ?? {})
            .map(([k, v]) => `${memberLabel(k)}→${v.executor ?? '默认'}${v.model ? `/${v.model}` : ''}`)
            .join('、')}`
        : ''
      return {
        content: `团队「${def.name}」\n成员：${def.members.map(memberLabel).join(', ')}\n牵头：${memberLabel(def.lead ?? def.members[0])}\n策略：${def.strategy}\n失败处理：${def.on_failure ?? 'stop'}${gateInfo}${overrideInfo}\n调度次数：${dispatchCount(id)}`,
        details: { def, dispatches: dispatchCount(id), dangling: danglingExperts(def) },
      }
    },
  })

  pi.registerTool({
    name: 'team_replay',
    label: '重放团队节点',
    description:
      '重跑某支团队上一次调度里的单个成员（LoopForge 节点级重放）：不改定义，只重跑那一名成员并把新产出写回运行记录',
    parameters: {
      type: 'object',
      properties: {
        team_id: { type: 'string', description: '团队 id' },
        member: { type: 'string', description: '要重跑的成员键（与定义里一致）' },
        run_id: { type: 'string', description: '目标运行 id；省略则取最近一次' },
      },
      required: ['team_id', 'member'],
      additionalProperties: false,
    },
    execute: async (_id: string, args: any): Promise<ToolResult> => {
      const id = String(args?.team_id ?? '').trim()
      const member = String(args?.member ?? '').trim()
      const def = readDef(id)
      if (!def) return { content: `团队 ${id} 不存在`, terminate: false }
      if (!def.members.includes(member)) {
        return {
          content: `成员「${member}」不在团队里。可选：${def.members.join('、')}`,
          terminate: false,
        }
      }
      const runs = readRuns(id)
      const wanted = String(args?.run_id ?? '').trim()
      const run = wanted
        ? runs.find((r) => r.runId === wanted)
        : runs[runs.length - 1]
      if (!run) return { content: `团队 ${id} 没有可重放的运行记录`, terminate: false }
      if (!run.task) {
        return {
          content: `运行 #${run.runId} 的日志里没有任务原文（早期版本未记录），无法重放`,
          terminate: false,
        }
      }
      const useReal = await hasPi()
      if (!useReal) {
        return { content: '本机无 pi，无法真实重放成员', terminate: false }
      }
      const replayRunId = `${run.runId}-r${randomUUID().slice(0, 4)}`
      const board = readBoard(id)
      const started = Date.now()
      appendRunLog(id, {
        runId: replayRunId,
        type: 'member_start',
        member,
        label: memberLabel(member),
        lead: member === def.lead,
        replay_of: run.runId,
        at: Date.now(),
      })
      const result = await runMember(def, member, run.task, board, replayRunId)
      appendRunLog(id, {
        runId: replayRunId,
        type: 'member_end',
        member,
        label: memberLabel(member),
        ok: result.ok,
        cancelled: !!result.cancelled,
        replay_of: run.runId,
        duration_ms: Date.now() - started,
        tokens: result.tokens ?? 0,
        output: result.output.slice(0, 2000),
        at: Date.now(),
      })
      appendRunLog(id, {
        runId: replayRunId,
        type: 'run_end',
        team: def.name,
        replay_of: run.runId,
        real: true,
        at: Date.now(),
      })
      return {
        content: result.ok
          ? `已重放成员「${memberLabel(member)}」（原运行 #${run.runId}）：\n${result.output.slice(0, 1200)}`
          : `重放成员「${memberLabel(member)}」失败：${result.output.slice(0, 400)}`,
        details: { replay_of: run.runId, member, ok: result.ok, output: result.output },
      }
    },
  })

  pi.registerCommand('team', {
    description: '团队召唤：/team dispatch <id> <任务> 直接调度；空参数列出已建团队',
    handler: async (arg: string, ctx: any) => {
      const text = arg.trim()
      if (text.startsWith('dispatch ')) {
        const body = text.slice('dispatch '.length)
        const gap = body.search(/\s/)
        const id = gap < 0 ? body : body.slice(0, gap)
        const task = gap < 0 ? '' : body.slice(gap + 1).trim()
        const res = await dispatchTeam(id, task)
        ctx.ui?.notify(res.content.split('\n')[0], 'info')
        return
      }
      const teams = listTeams()
      ctx.ui?.notify(
        teams.length ? `team: ${teams.map((x) => `${x.id} ${x.name}`).join(' / ')}` : 'team: 尚无团队',
        'info',
      )
    },
  })

  try {
    pi.setActiveTools(['team_create', 'team_dispatch', 'team_status', 'team_replay'])
  } catch {
    /* 运行时未就绪则跳过 */
  }
}
