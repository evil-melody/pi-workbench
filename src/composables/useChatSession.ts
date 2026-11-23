import { ref } from 'vue'
import { activeReplayIndex } from './useReplay'

/**
 * 对话轮次计数。
 *
 * 消息与流式状态都活在 `ChatView` 实例内部（`usePi()` 每次调用都是新的一份），
 * 所以「新会话」不能只做 `router.push('/chat')` —— 路由没变，组件不重新挂载，
 * 点了等于没点。把轮次挂到路由视图的 key 上，加一就得到一次干净的重挂载。
 */
export const chatEpoch = ref(0)

/**
 * 对话页 UI 态（面板开合 / 抽屉页签 / 专家选择）。
 *
 * 路由切走再切回时 ChatView 会重挂载，本地 ref 全部丢失——用户看到的是
 * 「面板突然没了、专家 chip 空了」，而内核那轮还在跑。这些是**会话级**状态，
 * 跟 chatEpoch 同寿命：切页保留，点「新会话」才清。
 */
export const traceOpen = ref(false)
export const drawerTab = ref<string | undefined>(undefined)
export const expertQueue = ref<string[]>([])

export function startNewSession() {
  // 新会话不再指向任何历史段，侧栏的选中高亮随之清掉。
  activeReplayIndex.value = null
  traceOpen.value = false
  drawerTab.value = undefined
  expertQueue.value = []
  chatEpoch.value += 1
}
