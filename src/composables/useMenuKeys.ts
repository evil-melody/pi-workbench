/** 菜单键盘导航：ArrowUp/Down 只移动焦点（跳过禁用项），Home/End 到首尾。
 *  Enter/Space 由原生 button 触发；Esc 的关闭与焦点归还由 useCtxMenu 负责。 */
export function onMenuKeydown(e: KeyboardEvent) {
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return
  const root = e.currentTarget as HTMLElement
  const items = [...root.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')]
  if (!items.length) return
  const current = items.indexOf(document.activeElement as HTMLElement)
  const next =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? items.length - 1
        : current < 0
          ? 0
          : (current + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
  e.preventDefault()
  items[next].focus()
}

/** 菜单刚打开时把焦点送到第一项，方向键才有起点。 */
export function focusFirstMenuItem(root?: HTMLElement | null) {
  root?.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus()
}
