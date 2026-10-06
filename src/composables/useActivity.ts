import { computed, ref, toValue, watch, type MaybeRefOrGetter } from 'vue'
import type { PiMsg } from './usePi'

export type ActivityPhase = 'idle' | 'working' | 'waiting' | 'completed' | 'interrupted' | 'failed'

export interface ActivityState {
  phase: ActivityPhase
  skill?: string
  tool?: string
  delivered: boolean
  children: { id: string; label?: string }[]
}

function empty(): ActivityState {
  return { phase: 'idle', delivered: false, children: [] }
}

/**
 * 从 Pi 消息流降级推导出活动状态。
 *
 * 轨迹面板依赖 `turn/start`、`tool/call`、`tool/result`、
 * `subagent/catalog`、`deliverables/presented`、`turn/end` 等细粒度事件。
 * 当前 `pi://event` 只暴露了 `message_update` / `agent_settled` / `process_exit`，
 * 因此这里做降级投影：
 * - streaming=true → working
 * - agent_settled 且前面无报错 → completed
 * - 有 lastAgentError 或消息里含失败语义 → failed
 * - 否则 idle。
 *
 * 当后端补齐细粒度事件后，可整体替换为 `packages/plugins/activity/src/projection.ts`
 * 的真实实现。
 */
export function useActivity(
  messages: MaybeRefOrGetter<PiMsg[]>,
  streaming: MaybeRefOrGetter<boolean>,
) {
  const state = ref<ActivityState>(empty())

  /**
   * 中断保持标志：用户点了中断后，强行把相位钉在 `interrupted`，
   * 直到内核真正回 `process_exit`（streaming 由 true 变 false）才交还给自动投影。
   */
  let manualHold = false

  function interrupt() {
    manualHold = true
    state.value = { ...empty(), phase: 'interrupted', delivered: true }
  }

  watch(
    () => toValue(streaming),
    (now, before) => {
      if (manualHold && before === true && now === false) manualHold = false
    },
  )

  const lastAssistant = computed(() => {
    const list = toValue(messages)
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].role === 'assistant') return list[i]
    }
    return null
  })

  watch(
    [lastAssistant, () => toValue(streaming)],
    () => {
      const list = toValue(messages)
      const last = lastAssistant.value
      const text = last?.text?.toLowerCase() ?? ''
      const nowStreaming = toValue(streaming)

      if (manualHold) {
        // 内核已回 process_exit → 交还自动投影；新一轮又跑起来 → 同样交还。
        if (nowStreaming) manualHold = false
        else return
      }

      if (nowStreaming) {
        state.value = {
          ...empty(),
          phase: 'working',
          tool: last?.tool,
        }
        return
      }

      if (text.includes('error') || text.includes('失败') || text.includes('错误')) {
        state.value = { ...empty(), phase: 'failed' }
        return
      }

      if (last && !last.streaming && list.length > 0) {
        state.value = {
          ...empty(),
          phase: 'completed',
          delivered: text.includes('```') || text.includes('文件') || text.includes('保存'),
        }
        return
      }

      state.value = empty()
    },
    { immediate: true },
  )

  return { state, interrupt }
}

export function activityMessage(state: ActivityState): string {
  if (state.phase === 'waiting') return '需要你确认'
  if (state.phase === 'interrupted') return '任务已中断，已有成果保留'
  if (state.phase === 'failed') return '本轮未完成，请查看原始过程'
  if (state.phase === 'completed') return state.delivered ? '本轮结束 · 已交付成果' : '本轮已结束'
  if (state.phase === 'idle') return '准备好了'
  if (state.tool) return '正在执行工具'
  return '正在处理'
}
