/**
 * 标签页键盘导航：方向键在 tablist 内移动并激活，Home / End 跳首尾。
 * 各页标签条结构相同，统一走这一份，避免每处重复写 keydown。
 */
export function onTablistKeydown(e: KeyboardEvent) {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
  if (!keys.includes(e.key)) return
  const root = e.currentTarget as HTMLElement
  const tabs = [...root.querySelectorAll<HTMLElement>('[role="tab"]:not([disabled])')]
  if (!tabs.length) return
  const current = tabs.indexOf(document.activeElement as HTMLElement)
  const base = current < 0 ? 0 : current
  const next =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? tabs.length - 1
        : (base + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
  e.preventDefault()
  tabs[next].focus()
  tabs[next].click()
}
