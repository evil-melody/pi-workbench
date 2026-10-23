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
 */
import path from 'node:path'
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'

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

    if (verdict.level === 'allow') {
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

    // confirm：风险命令需用户批准
    const detail =
      toolName === 'bash'
        ? String(event?.input?.command ?? '')
        : `${toolName}: ${String(event?.input?.path ?? '')}`
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
