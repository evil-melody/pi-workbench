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

/**
 * 把底层 IPC 错误转成用户能读懂的文案。
 *
 * 纯浏览器下 `invoke` 抛的是 `Cannot read properties of undefined (reading 'invoke')`
 * 这类 TypeError，直接显示在界面上等于没解释。这里统一转成「怎么做才能用」。
 * 各页的错误处理都走这一个口径，避免同一类错误在每页各写一遍文案。
 */
export function describeIpcError(e: unknown, action: string): string {
  const raw = e instanceof Error ? e.message : String(e)
  if (!isTauriRuntime()) {
    return `${action}需要在桌面 App（pnpm tauri dev）中运行：浏览器预览没有 Tauri 通道。`
  }
  return `${action}失败：${raw}`
}
