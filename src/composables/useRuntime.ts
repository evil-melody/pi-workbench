import { t } from '@/i18n'
import { ipcErrorText } from '@/i18n/errors'

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
 * 把底层 IPC 错误转成用户能读懂的文案。
 *
 * 后端错误有两层：结构化 `{ code, params, detail }`（新命令），或约定形状的
 * 字符串 `code` / `code: detail`（存量命令）。两种都先查错误码词条，
 * 查不到才退回 `detail` 原文，任何阶段都不把 raw key 显示给用户。
 * 纯浏览器下 `invoke` 抛的是 TypeError，这里统一说明「需要在桌面 App 运行」。
 */
export function describeIpcError(e: unknown, action: string): string {
  const actionText = t(action)
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
  return t('{action}失败：{detail}', { action: actionText, detail: raw })
}
