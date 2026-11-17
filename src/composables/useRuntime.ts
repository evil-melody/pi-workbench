import { currentLocale, t } from '@/i18n'
import { cleanErrorDetail, ipcErrorText } from '@/i18n/errors'

/**
 * 运行环境探测。
 *
 * Tauri v2 会在 `window` 上注入 `__TAURI_INTERNALS__`；纯浏览器（`pnpm dev` /
 * 构建产物直开）没有它。本仓凡走 Tauri 命令的能力，缺这个全局时必然静默失败、
 * 页面看起来像「卡死」。统一在这里判定，供守卫与横幅共用。
 */
let cached: boolean | null = null

export function isTauriRuntime(): boolean {
  if (cached !== null) return cached
  cached = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
  return cached
}

export function useRuntime(): { isTauri: boolean } {
  return { isTauri: isTauriRuntime() }
}

interface IpcErrorPayload {
  code: string
  params?: Record<string, unknown>
  detail?: string
}

/** 后端错误码约定：`domain/kebab-case`，可选 `: detail` 尾巴。 */
const IPC_CODE = /^([a-z][a-z0-9-]*\/[a-z0-9-]+)(?::\s?([\s\S]*))?$/

function fromString(raw: string): IpcErrorPayload | null {
  const match = raw.match(IPC_CODE)
  if (!match) return null
  return { code: match[1], detail: match[2] || undefined }
}

function asIpcError(value: unknown): IpcErrorPayload | null {
  if (typeof value === 'string') return fromString(value)
  if (!value || typeof value !== 'object') return null
  const code = (value as { code?: unknown }).code
  if (typeof code !== 'string' || !code) return null
  const source = value as { params?: unknown; detail?: unknown }
  return {
    code,
    params:
      source.params && typeof source.params === 'object'
        ? (source.params as Record<string, unknown>)
        : undefined,
    detail: typeof source.detail === 'string' ? source.detail : undefined,
  }
}

/**
 * 原始错误的常见形态 → 人话原因。只看特征，不把原文带进界面；
 * 顺序有讲究：权限/不存在优先，避免 `command not found` 被归成通用错误。
 */
const ERROR_REASONS: ReadonlyArray<readonly [RegExp, () => string]> = [
  [
    /EACCES|EPERM|permission denied|operation not permitted|not allowed/i,
    () => t('权限不足，当前账户无法访问该文件或目录。请换一个可写路径，或在系统设置里授予访问权限后重试。'),
  ],
  [
    /ENOENT|no such file|not found|cannot find/i,
    () => t('找不到对应的文件或命令。请确认路径是否正确，或重新选择文件后再试。'),
  ],
  [
    /ETIMEDOUT|timeout|timed out|deadline exceeded/i,
    () => t('等待后端响应超时。请稍后重试；若一直超时，重启应用再试。'),
  ],
  [
    /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|network|fetch failed|dns/i,
    () => t('网络连接失败，无法访问目标服务。请检查网络与地址配置后重试。'),
  ],
  [
    /unknown command|not implemented|not supported|unsupported|no such command/i,
    () => t('当前版本还不支持这个操作。请更新到最新版本后重试。'),
  ],
  [
    /database is locked|resource busy|EBUSY|already locked/i,
    () => t('资源正被占用，另一个操作可能还没结束。请稍候重试。'),
  ],
]

/** 已经写好、可以原样展示的中文 detail 才放行；英文堆栈一律走通用文案。 */
const HUMAN_DETAIL = /[\u4e00-\u9fff]/
const TECH_TRACE =
  /\n\s+at\s|\bat\s+\S+\s+\(|panicked at|RUST_BACKTRACE|\.rs:\d+|\.ts:\d+|node_modules|\/Users\/|\/home\//

/**
 * 把底层 IPC 错误转成用户能读懂的文案。
 *
 * 后端错误有两层：结构化 `{ code, params, detail }`（新命令），或约定形状的
 * 字符串 `code` / `code: detail`（存量命令）。两种都先查错误码词条，
 * 查不到才退回清洗后的 `detail`，任何阶段都不把 raw key / 堆栈显示给用户。
 * 纯浏览器下 `invoke` 抛的是 TypeError，这里统一说明「需要在桌面 App 运行」。
 * 原始错误只写控制台，便于排查。
 */
export function describeIpcError(e: unknown, action: string): string {
  const actionText = t(action)
  console.warn(`[ipc-error] ${actionText}`, e)
  if (!isTauriRuntime()) {
    return t('{action}需要在桌面 App（pnpm tauri dev）中运行：浏览器预览没有 Tauri 通道。', {
      action: actionText,
    })
  }
  const structured = asIpcError(e)
  if (structured) {
    return t('{action}失败：{detail}', {
      action: actionText,
      detail: ipcErrorText(structured.code, structured.params, structured.detail),
    })
  }
  const raw = e instanceof Error ? e.message : String(e)
  for (const [pattern, reason] of ERROR_REASONS) {
    if (pattern.test(raw)) {
      return t('{action}失败：{reason}', { action: actionText, reason: reason() })
    }
  }
  const detail = cleanErrorDetail(raw).replace(/[。.\s]+$/, '')
  // 后端 detail 是中文：英文界面直接透出会中英混排，只保留通用英文文案。
  if (
    currentLocale() === 'zh-CN' &&
    HUMAN_DETAIL.test(detail) &&
    !TECH_TRACE.test(raw) &&
    detail.length <= 160
  ) {
    return t('{action}失败：{detail}。请重试；若持续出现，可在日志里查看详细信息。', {
      action: actionText,
      detail,
    })
  }
  return t('{action}失败：发生了未预期的错误。请重试；若持续出现，可在日志里查看详细信息。', {
    action: actionText,
  })
}
