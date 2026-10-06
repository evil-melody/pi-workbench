import { invoke } from '@tauri-apps/api/core'
import { IN_TAURI } from './usePi'

/**
 * 前端日志桥：把浏览器侧的 console 输出与关键路径打点打到桌面 App 的终端。
 *
 * 桌面 App 里没有常驻 devtools，「点了没反应 / 整窗卡死」这类只在真实运行时
 * 出现的缺陷，日志是唯一能拿到现场的手段 —— 类型检查、构建、渲染回归都抓不到。
 */

const MAX = 1000

function stringify(v: unknown): string {
  if (typeof v === 'string') return v
  if (v instanceof Error) return `${v.name}: ${v.message}`
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export function webLog(level: 'info' | 'warn' | 'error', ...args: unknown[]) {
  if (!IN_TAURI) return
  const text = args.map(stringify).join(' ').slice(0, MAX)
  void invoke('app_log', { level, msg: text }).catch(() => {})
}

/** 关键路径打点：比 console 更可控，只在桌面模式下发。 */
export function traceLog(step: string, detail: unknown = '') {
  webLog('info', `[${step}]`, detail)
}

/**
 * 接管 `console.warn/error`：Vue 会把渲染期异常吞进 console.error，
 * 只看 `pageerror` 或只看界面都会漏掉整类崩溃。浏览器模式下保持原样。
 */
export function installWebLogBridge() {
  if (!IN_TAURI) return
  const warn = console.warn.bind(console)
  const error = console.error.bind(console)
  console.warn = (...args: unknown[]) => {
    webLog('warn', ...args)
    warn(...args)
  }
  console.error = (...args: unknown[]) => {
    webLog('error', ...args)
    error(...args)
  }
  window.addEventListener('unhandledrejection', (e) => {
    webLog('error', 'unhandledrejection:', e.reason)
  })
}
