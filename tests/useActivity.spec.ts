import { describe, expect, it } from 'vitest'
import { effectScope, nextTick, ref } from 'vue'
import { useActivity } from '@/composables/useActivity'
import type { PiMsg } from '@/composables/usePi'

function setup(messages: PiMsg[], streaming: boolean) {
  const scope = effectScope()
  const msgs = ref(messages)
  const running = ref(streaming)
  const api = scope.run(() => useActivity(msgs, running))!
  return {
    ...api,
    async push(m: PiMsg, nextStreaming = running.value) {
      msgs.value = [...msgs.value, m]
      running.value = nextStreaming
      await nextTick()
    },
    dispose: () => scope.stop(),
  }
}

const assistant = (text: string): PiMsg => ({ id: 'a1', role: 'assistant', text })

describe('useActivity · 相位投影', () => {
  it('空会话且非流式时为 idle，活动条不渲染', async () => {
    const a = setup([], false)
    await nextTick()
    expect(a.state.value.phase).toBe('idle')
    a.dispose()
  })

  it('流式进行中推为 working', async () => {
    const a = setup([], true)
    await nextTick()
    expect(a.state.value.phase).toBe('working')
    a.dispose()
  })

  it('一轮结束且产物判据命中时推为 completed + delivered', async () => {
    const a = setup([], false)
    await a.push(assistant('已写好 ```ts 文件'), false)
    expect(a.state.value.phase).toBe('completed')
    expect(a.state.value.delivered).toBe(true)
    a.dispose()
  })

  it('一轮结束但无产物判据时 delivered 为 false', async () => {
    const a = setup([], false)
    await a.push(assistant('好的'), false)
    expect(a.state.value.phase).toBe('completed')
    expect(a.state.value.delivered).toBe(false)
    a.dispose()
  })

  it('文本含失败语义时推为 failed', async () => {
    const a = setup([], false)
    await a.push(assistant('构建失败：missing dep'), false)
    expect(a.state.value.phase).toBe('failed')
    a.dispose()
  })
})

describe('useActivity · 中断', () => {
  it('interrupt() 立即把相位置为 interrupted', async () => {
    const a = setup([], true)
    await nextTick()
    a.interrupt()
    expect(a.state.value.phase).toBe('interrupted')
    expect(a.state.value.delivered).toBe(true)
    a.dispose()
  })

  it('中断后内核回 process_exit（streaming 落 false）仍保持 interrupted', async () => {
    const a = setup([], true)
    await nextTick()
    a.interrupt()
    await nextTick()
    await a.push(assistant(''), false)
    expect(a.state.value.phase).toBe('interrupted')
    a.dispose()
  })

  it('中断后下发新任务（streaming 回 true）交还自动投影为 working', async () => {
    const a = setup([], true)
    await nextTick()
    a.interrupt()
    await a.push(assistant(''), true)
    expect(a.state.value.phase).toBe('working')
    a.dispose()
  })
})
