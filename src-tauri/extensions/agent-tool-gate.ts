/**
 * B1 执行守卫（硬闸）：经 Pi 扩展 `pi.on('tool_call')` 在工具执行前拦截
 * bash / edit / write，内核进程内生效，无需内核改动。
 *
 * 三级判定（classifyToolCall 纯函数，可单测）：
 * - block + terminate：灾难命令（rm -rf / git push --force / curl|sh / dd of=/dev /
 *   mkfs / fork bomb / 关机 / 清空权限 / 写块设备）与受保护路径写入——无横幅直接拦。
 * - confirm：风险命令（sudo / rm / git reset --hard / 全局安装 / docker / chmod /
 *   系统服务 / 写系统路径）与写到项目目录外——`ctx.ui.confirm` 审批，
 *   超时（90s）/ 无 UI / 异常一律 fail-closed 拒绝。
 * - allow：read / grep / 项目内写入等不拦截。
 *
 * 审批回传协议（rpc 模式）：Pi 发 `{"type":"extension_ui_request","id",...}`，
 * 宿主回 `{"type":"extension_ui_response","id","confirmed":bool}`——
 * Tauri 侧由 `pi_ui_response` 命令下发，前端 ApprovalDialog 消费。
 *
 * 无人值守（阶段 1）：调度器执行 jobs 时会把预授权写进
 * `<PI_CODING_AGENT_DIR>/proactive-policy.json`。本扩展每次工具调用前读该文件：
 * 在授权范围内自动放行，越界一律 block（不是弹窗等待）——无人值守时没人点按钮，
 * 边界必须由代码裁定；越界动作记入 `proactive-audit.jsonl` 供事后审计。
 * 没有 activeJob 时行为与之前完全一致（交互审批）。
 */
import path from 'node:path'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'

type GateLevel = 'allow' | 'confirm' | 'block'
type GateVerdict = { level: GateLevel; reason?: string; terminate?: boolean }

// —— G3 checkpoint：edit/write 放行前把目标文件备份进当前 turn ——
//
// 目录来自 Rust spawn 时注入的 PI_CHECKPOINT_DIR；turn 边界由 Rust 的
// checkpoint_begin_turn 打 marker（turn-<seq>.json），这里只认最大 seq。
// 镜像规则与 Rust `checkpoint::mirror_rel` 一致：绝对路径去掉前导 '/'。
// 备份是保险丝不是闸门：任何失败都静默跳过，绝不拦工具执行。

/** checkpoint 目录（未注入返回 null）。 */
function checkpointDir(): string | null {
  const d = process.env.PI_CHECKPOINT_DIR
  return d && d.trim() ? d : null
}

/** 目录里现存的最大 turn seq；无 marker 返回 null（尚未开轮）。 */
export function currentTurnSeq(dir: string): number | null {
  let max: number | null = null
  for (const name of readdirSync(dir)) {
    const m = /^turn-(\d+)\.json$/.exec(name)
    if (m) {
      const n = Number(m[1])
      if (max === null || n > max) max = n
    }
  }
  return max
}

/** 备份目标路径：`<dir>/turn-<seq>/<去前导斜杠的绝对路径>`。 */
export function backupDestFor(absPath: string, dir: string, seq: number): string {
  return path.join(dir, `turn-${seq}`, absPath.replace(/^\/+/, ''))
}

/**
 * 备份一个 edit/write 目标。first-write-wins：同轮二次编辑不覆盖首个备份
 * （那才是该轮开始前的原内容）。源不存在（write 新建）不备份。
 * 返回是否落盘；失败一律 false 且不抛。
 */
export function backupEditTarget(absPath: string): boolean {
  try {
    const dir = checkpointDir()
    if (!dir || !existsSync(dir)) return false
    const seq = currentTurnSeq(dir)
    if (seq === null) return false
    if (!existsSync(absPath)) return false
    const dest = backupDestFor(absPath, dir, seq)
    if (existsSync(dest)) return false
    mkdirSync(path.dirname(dest), { recursive: true })
    copyFileSync(absPath, dest)
    return true
  } catch {
    return false
  }
}

const PROTECTED_DIRS = [
  '/etc',
  '/usr',
  '/System',
  '/private/etc',
  process.env.HOME ? path.join(process.env.HOME, '.ssh') : '',
  process.env.HOME ? path.join(process.env.HOME, '.gnupg') : '',
].filter(Boolean)

const PROTECTED_FILE_GLOB = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)id_rsa$/i,
  /(^|\/)known_hosts$/i,
  /(^|\/)credentials$/i,
]

// 灾难：命中即 block + terminate。
const DISASTER: Array<[RegExp, string]> = [
  [/\brm\s+-r\w*f\b|\brm\s+-rf\b|\brm\s+-fr\b|\brm\s+--recursive\b/i, 'rm -rf 递归删除可能误删大量文件'],
  [/\bgrep\s+.*\|\s*(sudo\s+)?rm\b/i, '管道内 rm 危险'],
  [/\bgit\s+push\s+(--force|-f)\b|\bgit\s+push\s+.*\s+--force\b|\bgit\s+push\s+--delete\b/i, 'git push --force/--delete 会覆盖远端历史'],
  [/(curl|wget)\s+[^|]*\|\s*(sudo\s+)?(sh|bash|python|perl)\b/i, '从网络下载脚本并直接执行（curl|sh）'],
  [/\bdd\b[^|]*\bof=\/dev\//i, 'dd 写入设备（of=/dev/*）'],
  [/\bmkfs\b/i, 'mkfs 格式化文件系统'],
  [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, 'fork bomb'],
  [/\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/i, '关机/重启命令'],
  [/\b(chmod|chown)\s+-R\s+0?0?0\b|\b(chmod|chown)\s+000\b/i, 'chmod/chown 000 清空权限'],
  [/>\s*\/dev\/(sd|hd|nvme|loop|sda)/i, '重定向写入块设备'],
]

// 风险：需 confirm。
const RISKY: Array<[RegExp, string]> = [
  [/\bsudo\b/i, 'sudo 提权执行'],
  [/\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*f/i, 'git reset --hard / git clean 会丢弃未提交改动'],
  [/\brm\b/i, 'rm 删除文件/目录'],
  [/\bnpm\s+(i|install)\s+-g\b|\byarn\s+global\b|\bpnpm\s+add\s+-g\b/i, '全局安装包'],
  [/\bdocker\s+run\b|\bdocker\s+rm\b|\bdocker\s+exec\b/i, 'docker 容器操作'],
  [/\bchmod\b|\bchown\b/i, '修改文件权限/归属'],
  [/\bsystemctl\b|\bservice\s+/i, '系统服务管理'],
  [/\bmv\s+.*\s+\/|\bcp\s+.*\s+\//i, '移动/复制到系统路径'],
]

function isProtectedPath(p: string | undefined): boolean {
  if (!p) return false
  const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p)
  if (PROTECTED_DIRS.some((d) => abs.startsWith(d + '/'))) return true
  if (PROTECTED_FILE_GLOB.some((re) => re.test(abs))) return true
  return false
}

// —— 无人值守预授权（硬边界，阶段 1） ——
//
// 策略文件由 Rust 调度器在任务开始/结束时整体覆写，扩展只读不写；
// 文件缺失、解析失败、过期一律视为「没有预授权」→ 走原来的交互审批。

export type ActiveJob = {
  id: string
  startedAt: number
  expiresAt: number
  grant?: {
    bashAllow?: string[]
    writeRoots?: string[]
    maxToolCalls?: number
  }
}

const agentDir = () => (process.env.PI_CODING_AGENT_DIR ?? '').trim()

/** 读当前无人值守任务；过期或结构不合法返回 null。 */
export function readActiveJob(): ActiveJob | null {
  const dir = agentDir()
  if (!dir) return null
  try {
    const raw = JSON.parse(readFileSync(path.join(dir, 'proactive-policy.json'), 'utf8'))
    const job = raw?.activeJob
    if (!job || typeof job.id !== 'string') return null
    if (typeof job.expiresAt === 'number' && Date.now() > job.expiresAt) return null
    return job as ActiveJob
  } catch {
    return null
  }
}

/** 预授权审计：只追加一行 JSON，写失败不影响闸门判定。 */
export function auditDenial(job: ActiveJob, toolName: string, detail: string): void {
  const dir = agentDir()
  if (!dir) return
  try {
    appendFileSync(
      path.join(dir, 'proactive-audit.jsonl'),
      JSON.stringify({
        kind: 'gate_denied',
        job: job.id,
        tool: toolName,
        detail: detail.slice(0, 500),
        at: Date.now(),
      }) + '\n',
    )
  } catch {
    /* 审计落盘失败不改变拒绝结论 */
  }
}

/** 单次运行的累计风险动作计数：跨工具调用保留，任务切换时归零。 */
let countedJobId = ''
let countedCalls = 0

/** 消耗一次风险动作额度；超出返回 false，并把用量写回供设置页展示。 */
export function consumeToolBudget(job: ActiveJob): boolean {
  if (countedJobId !== job.id) {
    countedJobId = job.id
    countedCalls = 0
  }
  const cap = job.grant?.maxToolCalls ?? 40
  const ok = countedCalls < cap
  if (ok) countedCalls += 1
  const dir = agentDir()
  if (dir) {
    try {
      writeFileSync(
        path.join(dir, 'proactive-usage.json'),
        JSON.stringify({ jobId: job.id, used: countedCalls, max: cap, at: Date.now() }),
      )
    } catch {
      /* 展示用数据，写失败不影响额度判定 */
    }
  }
  return ok
}

/** 判断一次需审批的动作是否落在预授权内。 */
export function withinGrant(
  job: ActiveJob,
  toolName: string,
  input: Record<string, unknown> | undefined,
): { ok: boolean; reason: string } {
  const inp: Record<string, unknown> = input ?? {}
  if (toolName === 'bash') {
    const command = String(inp.command ?? '').trim()
    // 前缀匹配挡不住「白名单命令; 任意命令」，含分隔符/替换/重定向一律拒绝。
    if (/[;&|`$()<>\n\r]/.test(command)) {
      return { ok: false, reason: '命令包含链式分隔符、变量展开或重定向' }
    }
    const allow = job.grant?.bashAllow ?? []
    if (!allow.length) return { ok: false, reason: '预授权未允许任何风险命令' }
    const hit = allow.find((prefix) => prefix.trim() && command.startsWith(prefix.trim()))
    return hit
      ? { ok: true, reason: `命中预授权前缀：${hit}` }
      : { ok: false, reason: '命令不在预授权前缀白名单内' }
  }
  if (toolName === 'write' || toolName === 'edit') {
    const target = String(inp.path ?? '')
    const abs = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target)
    const roots = job.grant?.writeRoots ?? []
    const hit = roots.find((root) => root.trim() && abs.startsWith(root.trim() + path.sep))
    return hit
      ? { ok: true, reason: `落在预授权写入根：${hit}` }
      : { ok: false, reason: '目标不在预授权写入根内' }
  }
  return { ok: false, reason: `未对工具 ${toolName} 预授权` }
}

/**
 * 纯函数分类器：给定工具名与输入，返回闸门判定。
 * 仅处理 bash / edit / write；其他工具一律 allow（交给各自逻辑）。
 */
export function classifyToolCall(
  toolName: string,
  input: Record<string, unknown> | undefined,
): GateVerdict {
  const inp: Record<string, unknown> = input ?? {}

  if (toolName === 'bash') {
    const command = String(inp.command ?? '')
    if (!command.trim()) return { level: 'allow' }
    for (const [re, reason] of DISASTER) {
      if (re.test(command)) return { level: 'block', reason, terminate: true }
    }
    for (const [re, reason] of RISKY) {
      if (re.test(command)) return { level: 'confirm', reason }
    }
    return { level: 'allow' }
  }

  if (toolName === 'write' || toolName === 'edit') {
    const target = String(inp.path ?? '')
    // 受保护路径（/etc、~/.ssh、.env 等）：直接 block，不给审批机会。
    if (isProtectedPath(target)) {
      return { level: 'block', reason: `${toolName} 目标是受保护路径：${target}`, terminate: false }
    }
    // 项目边界：相对路径按 cwd 解析属项目内；绝对路径必须落在 cwd 下。
    const abs = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target)
    const inProject = Boolean(target) && abs.startsWith(process.cwd() + path.sep)
    if (!inProject) return { level: 'confirm', reason: `${toolName} 写到项目目录外：${target}` }
    return { level: 'allow' }
  }

  // read / grep / find / ls / mcp_call / 自定义工具：不拦截
  return { level: 'allow' }
}

/**
 * 就绪沙箱检查（裁剪版）：`.pi/sandboxes/<id>/` 存在且 `.pi/envs/<id>/bin` 已构建。
 * 与 sandbox-env.ts 的 listEnvs 同语义，这里只做布尔判定，避免跨扩展 import
 * （seed_defaults 只同步清单扁平文件，共享模块不进清单会断相对 import）。
 */
function hasReadySandbox(cwd: string): boolean {
  try {
    const base = path.join(cwd, '.pi', 'sandboxes')
    if (!existsSync(base)) return false
    return readdirSync(base).some((id) => existsSync(path.join(cwd, '.pi', 'envs', id, 'bin')))
  } catch {
    return false
  }
}

/** 交互审批：有 UI 时走 ctx.ui.confirm，超时（默认 90s）/ 无 UI / 异常 → false。 */
async function requestApproval(
  ctx: any,
  title: string,
  message: string,
  timeoutMs = 90_000,
): Promise<boolean> {
  const ui = ctx?.ui
  if (typeof ui?.confirm !== 'function') return false
  try {
    const settled = await Promise.race([
      Promise.resolve(ui.confirm(title, message)),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ])
    return Boolean(settled)
  } catch {
    return false
  }
}

export default function (pi: any) {
  pi.on('tool_call', async (event: any, ctx: any) => {
    const toolName: string = event?.toolName ?? ''
    const verdict = classifyToolCall(toolName, event?.input)
    // 只在有无人值守任务时启用预授权判定；否则保留原有的交互审批路径。
    const active = readActiveJob()

    if (verdict.level === 'allow') {
      // 无人值守下，即便分类器判 allow，写入仍必须落在预授权写入根内。
      if (active && (toolName === 'edit' || toolName === 'write')) {
        const g = withinGrant(active, toolName, event?.input)
        if (!g.ok) {
          auditDenial(active, toolName, String(event?.input?.path ?? g.reason))
          return { block: true, reason: `超出预授权写入边界：${g.reason}`, terminate: false }
        }
      }
      // G3 checkpoint：edit/write 放行前备份目标文件（相对路径按 cwd 解析）。
      // 失败不拦——备份链断了最多少一次回滚，误拦是直接干不了活。
      if (toolName === 'edit' || toolName === 'write') {
        const target = String(event?.input?.path ?? '')
        if (target) {
          const abs = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target)
          backupEditTarget(abs)
        }
      }
      return
    }

    if (verdict.level === 'block') {
      return { block: true, reason: verdict.reason ?? '被执行守卫拦截', terminate: verdict.terminate }
    }

    const detail =
      toolName === 'bash'
        ? String(event?.input?.command ?? '')
        : `${toolName}: ${String(event?.input?.path ?? '')}`

    // 无人值守：预授权内自动放行，越界一律拒绝并留审计。
    // 这里不能走 ctx.ui.confirm——夜间没人点按钮，等待只会把任务拖到超时。
    if (active) {
      // 额度只计「需审批的风险动作」：读文件/搜索不消耗额度，
      // 否则一个正常任务几十次只读调用就把额度烧光。
      if (!consumeToolBudget(active)) {
        auditDenial(active, toolName, '超出单次运行风险动作额度')
        return {
          block: true,
          reason: `超出无人值守预授权的风险动作额度（${active.grant?.maxToolCalls ?? 40} 次）`,
          terminate: false,
        }
      }
      const g = withinGrant(active, toolName, event?.input)
      if (g.ok) return
      auditDenial(active, toolName, detail || g.reason)
      return {
        block: true,
        reason: `超出无人值守预授权边界，需人工确认：${g.reason}`,
        terminate: false,
      }
    }

    // 沙箱联动：存在就绪沙箱时，风险 bash 命令直接重定向进沙箱，免宿主审批。
    if (toolName === 'bash' && hasReadySandbox(process.cwd())) {
      return {
        block: true,
        reason: `风险命令已重定向：请调用 sandbox_run(envId=...) 在沙箱内执行（原因：${verdict.reason ?? ''}）`,
        terminate: false,
      }
    }

    // confirm：风险命令需用户批准
    const approved = await requestApproval(
      ctx,
      '执行审批',
      `${verdict.reason ?? '该操作需要审批'}\n\n${detail}\n\n是否允许执行？`,
    )
    if (approved) return // 放行
    return { block: true, reason: `用户拒绝执行：${verdict.reason ?? ''}`.trim(), terminate: false }
  })

  // 信息工具：查看当前守卫策略概况（不拦截，仅诊断用）。
  pi.registerTool({
    name: 'gate_status',
    label: '执行守卫状态',
    description: '查看 B1 执行守卫的拦截规则概况（灾难黑名单 / 风险需审批 / 受保护路径）',
    parameters: {
      type: 'object',
      properties: {
        verbose: { type: 'boolean', description: '是否列出全部规则明细' },
      },
      additionalProperties: false,
    },
    execute: async (_id: string, args: any): Promise<{ content: string; details?: unknown }> => {
      const verbose = Boolean(args?.verbose)
      const summary = {
        disaster_rules: DISASTER.length,
        risky_rules: RISKY.length,
        protected_dirs: PROTECTED_DIRS,
        protected_globs: PROTECTED_FILE_GLOB.map((r) => r.source),
        gated_tools: ['bash', 'edit', 'write'],
        policy: 'disaster→block+terminate；risky→confirm(fail-closed)；受保护路径→block；其余放行',
      }
      const content = verbose
        ? JSON.stringify(summary, null, 2)
        : `执行守卫已启用：灾难命令 ${DISASTER.length} 条（拦截+终止）、风险命令 ${RISKY.length} 条（需审批）、受保护路径 ${PROTECTED_DIRS.length} 类。拦截工具：bash/edit/write。`
      return { content, details: summary }
    },
  })

  try {
    pi.setActiveTools(['gate_status'])
  } catch {
    /* 运行时未就绪则跳过 */
  }
}
