/**
 * 主题切换（dark / light）。
 *
 * 变量全部定义在 `styles/base.css` 的 `[data-theme]`，这里只负责往 `<html>` 上写属性，
 * 组件样式无需感知切换。选择项存 localStorage；用户没显式选过时跟随系统。
 */

import { invoke } from '@tauri-apps/api/core'
import { isTauriRuntime } from '@/composables/useRuntime'

export type Theme = 'dark' | 'light'

const KEY = 'pi-workbench:theme'
const FS_KEY = 'pi-workbench:font-scale'

/** 字号档位（对齐 WorkBuddy 设置「字号」）：值是 --fs-scale 因子。 */
export const FONT_SCALES = [
  { value: 'sm', scale: 0.9 },
  { value: 'md', scale: 1 },
  { value: 'lg', scale: 1.1 },
  { value: 'xl', scale: 1.2 },
] as const
export type FontScale = (typeof FONT_SCALES)[number]['value']

function fontScaleValue(): number {
  const saved = localStorage.getItem(FS_KEY)
  return FONT_SCALES.find((f) => f.value === saved)?.scale ?? 1
}

/** 首帧与启动时写入：<html> 上的因子让全站阶梯等比缩放。 */
export function applyFontScale(scale: number): void {
  document.documentElement.style.setProperty('--fs-scale', String(scale))
}

export function currentFontScale(): FontScale {
  const scale = fontScaleValue()
  return (FONT_SCALES.find((f) => f.scale === scale)?.value ?? 'md') as FontScale
}

export function setFontScale(value: FontScale): void {
  const found = FONT_SCALES.find((f) => f.value === value) ?? FONT_SCALES[1]
  localStorage.setItem(FS_KEY, found.value)
  applyFontScale(found.scale)
}

/**
 * 把主题同步给原生窗口底色（WebView 提交 HTML 前的那一帧由 Rust 侧绘制）。
 * 纯浏览器预览没有 Tauri 通道，调用直接跳过。
 */
function syncWindowTheme(theme: Theme): void {
  if (!isTauriRuntime()) return
  void invoke('window_set_theme', { theme }).catch(() => undefined)
}

function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

/** 返回实际生效的主题。首屏同步执行，避免闪白/闪黑。 */
export function initTheme(): Theme {
  const saved = localStorage.getItem(KEY)
  const theme: Theme = saved === 'light' || saved === 'dark' ? saved : systemTheme()
  document.documentElement.dataset.theme = theme
  applyFontScale(fontScaleValue())
  syncWindowTheme(theme)
  return theme
}

export function currentTheme(): Theme {
  return (document.documentElement.dataset.theme as Theme) ?? 'dark'
}

export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  localStorage.setItem(KEY, theme)
  syncWindowTheme(theme)
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
    syncWindowTheme(theme)
    cb(theme)
  }
  mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
}
