import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { ref } from 'vue'

export function useTerminal(getCwd: () => string) {
  const lines = ref<{ stream: string; line: string }[]>([])
  const running = ref(false)
  let unOut: UnlistenFn | null = null
  let unDone: UnlistenFn | null = null
  let activeId = ''

  async function ensure() {
    if (unOut) return
    unOut = await listen<any>('term://output', (e) => {
      if (e.payload.id === activeId)
        lines.value.push({ stream: e.payload.stream, line: e.payload.line })
    })
    unDone = await listen<any>('term://done', (e) => {
      if (e.payload.id === activeId) running.value = false
    })
  }

  async function exec(cmd: string) {
    await ensure()
    activeId = `t${Date.now()}`
    lines.value.push({ stream: 'cmd', line: `$ ${cmd}` })
    running.value = true
    await invoke('term_exec', { id: activeId, cwd: getCwd(), cmd })
  }

  function clear() {
    lines.value = []
  }

  return { lines, running, ensure, exec, clear }
}
