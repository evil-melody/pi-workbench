/**
 * Pi extension: 命令守卫（agent-guard）
 *
 * 最小可行命令防护（对应 WORKDSH-ALIGN-26 的 B6 + B1 软闸门）：
 *   · safe_shell 工具：对宿主执行的 shell 命令做危险模式黑名单 + 风险模式软闸门。
 *   · 灾难命令（rm -rf / git push --force / curl|sh / dd of=/dev / mkfs / fork bomb …）
 *     一律硬拦截，不执行。
 *   · 风险命令（sudo / git reset --hard / git clean / rm / chmod …）默认拦截并提示，
 *     仅当显式携带 confirm:true 才放行（B1 审批接缝的软件实现；硬审批需 Pi 内核 hook）。
 *   · 宿主 PATH 白名单：二进制落在已知安全目录或 PATH 上才允许，否则拒绝相对/异常路径。
 *
 * 说明：Pi 内置的 bash/edit/write/read 在 Pi 进程内执行，Tauri 侧无法拦截
 * （见 md 第六章 B1 架构阻塞说明）。本守卫覆盖的是经 safe_shell 显式下发的命令，
 * 其他 extension 的自有 shell-out 也应复用 guardShell。
 */

import { spawn } from 'node:child_process'

/// 灾难命令：命中即硬拦截，绝不执行。
const BLOCK_PATTERNS: [RegExp, string][] = [
  [/\brm\b[^\n]*(-r\b|-rf\b|--recursive\b)/i, 'rm -r/-rf 递归删除，可能误删大量文件'],
  [/\bgit\s+push\b[^\n]*(--force|-f\b|--delete)/i, 'git push --force/--delete 会覆盖远端历史'],
  [/\b(curl|wget)\b[^\n]*\|\s*(sh|bash)\b/i, '从网络下载脚本并直接执行，极易中招'],
  [/\bdd\b[^\n]*\bof=\/dev\//i, 'dd 写块设备可能破坏磁盘'],
  [/\bmkfs\b/i, 'mkfs 会格式化文件系统'],
  [/(^|\s):\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}/, 'fork bomb'],
  [/\b(shutdown|reboot|halt|poweroff)\b/i, '关机会中断系统'],
  [/>\s*\/dev\/(sd|nvme|hd|loop)/i, '重定向写入块设备'],
]

/// 风险命令：默认拦截并提示，confirm:true 才放行。
const WARN_PATTERNS: [RegExp, string][] = [
  [/\bsudo\b/i, 'sudo 以 root 执行'],
  [/\bgit\s+reset\s+--hard\b/i, 'git reset --hard 丢弃工作区改动'],
  [/\bgit\s+clean\b/i, 'git clean 删除未跟踪文件'],
  [/\brm\b/i, 'rm 删除文件'],
  [/\bchmod\b/i, 'chmod 改动权限'],
  [/\bnpm\s+install\s+-g\b/i, '全局安装会改动环境'],
  [/\bdocker\s+run\b/i, 'docker run 可能挂载宿主资源'],
]

export type GuardLevel = 'allow' | 'warn' | 'block'

export interface GuardVerdict {
  level: GuardLevel
  reason?: string
}

/**
 * 判定一条 shell 命令的安全级别。
 * @param command 完整命令字符串
 * @param confirm 调用方是否已显式确认风险命令
 */
export function guardShell(command: string, confirm: boolean): GuardVerdict {
  const cmd = String(command ?? '').trim()
  if (!cmd) return { level: 'block', reason: '空命令' }
  for (const [re, reason] of BLOCK_PATTERNS) {
    if (re.test(cmd)) return { level: 'block', reason }
  }
  for (const [re, reason] of WARN_PATTERNS) {
    if (re.test(cmd)) return confirm ? { level: 'allow' } : { level: 'warn', reason }
  }
  return { level: 'allow' }
}

/// 二进制可执行的宿主安全目录（PATH 上的标准位置）。
const SAFE_BIN_DIRS = [
  '/usr/bin',
  '/usr/local/bin',
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/bin',
  '/sbin',
]

/**
 * 宿主二进制路径白名单：
 *   · 相对路径（./script、../x）→ 拒绝（易执行当前目录下的意外脚本）
 *   · 绝对路径不在已知安全目录 → 拒绝
 *   · 裸命令名（走 PATH 解析）→ 允许
 */
export function binaryOnSafePath(command: string): boolean {
  const bin = String(command ?? '').trim().split(/\s+/)[0] ?? ''
  if (!bin) return false
  if (bin.startsWith('./') || bin.startsWith('../') || bin.startsWith('~')) return false
  if (bin.includes('/')) {
    return SAFE_BIN_DIRS.some((d) => bin === d || bin.startsWith(d + '/'))
  }
  return true
}

function execShell(command: string, timeoutMs = 60_000): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(command, [], { shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let done = false
    const finish = (code: number | null) => {
      if (done) return
      done = true
      resolve({ out, code })
    }
    child.stdout?.on('data', (d) => (out += d.toString()))
    child.stderr?.on('data', (d) => (out += d.toString()))
    child.on('error', (e) => {
      out += `\n[spawn error] ${String(e.message ?? e)}`
      finish(null)
    })
    child.on('close', (code) => finish(code))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      out += `\n[timeout ${timeoutMs}ms, killed]`
      finish(null)
    }, timeoutMs)
    child.on('close', () => clearTimeout(timer))
  })
}

export default function (pi: any) {
  pi.registerTool({
    name: 'safe_shell',
    label: '受控 shell 执行',
    description:
      '在宿主执行 shell 命令，但先经过危险命令黑名单与风险命令软闸门。灾难命令（rm -rf、git push --force、curl|sh 等）会被拦截；sudo/git reset --hard/rm 等风险命令需 confirm:true 才放行。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令' },
        confirm: { type: 'boolean', description: '确认执行风险命令（仅对 WARN 类生效，BLOCK 类无视此值）' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    execute: async (_id: string, args: any): Promise<{ content: string; details?: unknown; terminate?: boolean }> => {
      const command = String(args?.command ?? '').trim()
      const confirm = args?.confirm === true
      const verdict = guardShell(command, confirm)
      if (verdict.level === 'block') {
        return {
          content: `已拦截危险命令（${verdict.reason}）。本守卫不执行此类命令；如确需执行，请走人工审批流程而非绕过。`,
          terminate: false,
        }
      }
      if (verdict.level === 'warn') {
        return {
          content: `该命令存在风险（${verdict.reason}）。如确认执行，请带上 confirm:true 重试。`,
          terminate: false,
        }
      }
      if (!binaryOnSafePath(command)) {
        return {
          content: '二进制不在宿主安全 PATH 上（相对路径或异常绝对路径被拒绝）。请使用 PATH 上的标准命令。',
          terminate: false,
        }
      }
      const { out, code } = await execShell(command)
      return {
        content: `exit=${code}\n${out}`,
        details: { command, exit: code },
      }
    },
  })

  pi.registerCommand('guard_status', {
    description: '显示命令守卫状态（已启用黑名单 + 软闸门）',
    handler: async (_arg: string, ctx: any) => {
      ctx?.ui?.notify(
        `guard: 灾难命令硬拦截 ${BLOCK_PATTERNS.length} 条，风险命令软闸门 ${WARN_PATTERNS.length} 条`,
        'info',
      )
    },
  })

  try {
    pi.setActiveTools(['safe_shell'])
  } catch {
    /* 运行时未就绪则跳过 */
  }
}
