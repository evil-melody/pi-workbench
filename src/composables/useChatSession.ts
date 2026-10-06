import { ref } from 'vue'

/**
 * 对话轮次计数。
 *
 * 消息与流式状态都活在 `ChatView` 实例内部（`usePi()` 每次调用都是新的一份），
 * 所以「新会话」不能只做 `router.push('/chat')` —— 路由没变，组件不重新挂载，
 * 点了等于没点。把轮次挂到路由视图的 key 上，加一就得到一次干净的重挂载。
 */
export const chatEpoch = ref(0)

export function startNewSession() {
  chatEpoch.value += 1
}
