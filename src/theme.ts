/**
 * 主题切换（dark / light）。
 *
 * 变量全部定义在 `styles/base.css` 的 `[data-theme]`，这里只负责往 `<html>` 上写属性，
 * 组件样式无需感知切换。选择项存 localStorage；用户没显式选过时跟随系统。
 */

export type Theme = 'dark' | 'light'

const KEY = 'pi-workbench:theme'

function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

/** 返回实际生效的主题。首屏同步执行，避免闪白/闪黑。 */
export function initTheme(): Theme {
  const saved = localStorage.getItem(KEY)
  const theme: Theme = saved === 'light' || saved === 'dark' ? saved : systemTheme()
  document.documentElement.dataset.theme = theme
  return theme
}

export function currentTheme(): Theme {
  return (document.documentElement.dataset.theme as Theme) ?? 'dark'
}

export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  localStorage.setItem(KEY, theme)
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark'
  setTheme(next)
  return next
}

/** 用户没手动选过时，系统配色变化要跟着走。 */
export function watchSystemTheme(cb: (theme: Theme) => void): () => void {
  const mq = window.matchMedia('(prefers-color-scheme: light)')
  const onChange = (e: MediaQueryListEvent) => {
    if (localStorage.getItem(KEY)) return // 已有显式选择，不被系统覆盖
    const theme = e.matches ? 'light' : 'dark'
    document.documentElement.dataset.theme = theme
    cb(theme)
  }
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}
