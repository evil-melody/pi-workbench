import { onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * 公共「···」菜单的开合/定位/关闭逻辑（样式在 ui/ContextMenu.css）。
 *
 * Teleport 到 body 的菜单有两个通用问题，这里一次收口：
 * 1. 定位：锚点右侧对齐、窄屏左钳制，绝不溢出视口；
 * 2. 关闭：点菜单外任意处 / Esc 关，监听随组件生命周期自动摘除。
 *
 * 侧栏项目菜单与运行记录菜单共用这一份，不再各写一遍。
 */
export function useCtxMenu(width = 180) {
  const open = ref(false)
  const style = ref<Record<string, string>>({})

  /** 在锚点元素下方打开菜单（锚点取整行高亮的行容器/列表项）。 */
  function openAt(anchor: HTMLElement) {
    const r = anchor.getBoundingClientRect()
    const left = Math.min(Math.max(8, r.right - width), window.innerWidth - width - 8)
    style.value = {
      left: `${left}px`,
      top: `${r.bottom + 6}px`,
      width: `${width}px`,
    }
    open.value = true
  }

  function close() {
    open.value = false
  }

  function onDocClick(e: MouseEvent) {
    if (open.value && !(e.target as HTMLElement).closest('.ctx-menu')) close()
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') close()
  }

  onMounted(() => {
    document.addEventListener('click', onDocClick)
    document.addEventListener('keydown', onKey)
  })
  onBeforeUnmount(() => {
    document.removeEventListener('click', onDocClick)
    document.removeEventListener('keydown', onKey)
  })

  return { open, style, openAt, close }
}
