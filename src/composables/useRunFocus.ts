import { ref } from 'vue'

/**
 * 从消息里的「运行链路」入口跳到轨迹抽屉里的对应图。
 * 模块级单例：发起点（消息列表）与消费点（抽屉）不在同一层，走 props 会串很多层。
 */
const focusRunId = ref<string | null>(null)
const focusSeq = ref(0)

export function useRunFocus() {
  function focusRun(runId: string) {
    focusRunId.value = runId
    focusSeq.value += 1
  }
  return { focusRunId, focusSeq, focusRun }
}
