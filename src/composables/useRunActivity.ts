import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { ref } from 'vue'
import { IN_TAURI } from '@/composables/usePi'

/**
 * 「有任务在飞」的全局标记：侧栏运行记录据此在对应会话行上转圈。
 *
 * 只认 `pi://event` 的类型字段，不依赖组件树（侧栏不在 ChatView 的 provide 下），
 * 也不依赖某个对话页实例——主动任务这类没有对话页的运行同样能亮。
 */
const running = ref(false)
let unlisten: UnlistenFn | null = null
let starting = false
let idleTimer: ReturnType<typeof setTimeout> | null = null

/** follow_up 会在 agent_settled 后接着跑下一轮：延迟收尾，避免转圈闪断。 */
const IDLE_DELAY = 1200

const ACTIVE = new Set(['run_start', 'message_start', 'turn_start', 'tool_execution_start', 'agent_start'])
const IDLE = new Set(['agent_settled', 'process_exit'])

function clearIdle() {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

function scheduleIdle() {
  clearIdle()
  idleTimer = setTimeout(() => {
    running.value = false
    idleTimer = null
  }, IDLE_DELAY)
}

async function ensure() {
  if (unlisten || starting || !IN_TAURI) return
  starting = true
  try {
    unlisten = await listen<unknown>('pi://event', (e) => {
      const type = (e.payload as { type?: unknown } | null)?.type
      if (typeof type !== 'string') return
      if (ACTIVE.has(type)) {
        clearIdle()
        running.value = true
      } else if (IDLE.has(type)) scheduleIdle()
      // 其余事件（stats / queue 噪声）不动计时器：settle 后的收尾不该被它们续命。
    })
  } catch {
    unlisten = null
  } finally {
    starting = false
  }
}

export function useRunActivity() {
  void ensure()
  return { running }
}
