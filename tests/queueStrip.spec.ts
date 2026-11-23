// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import QueueStrip from '@/components/chat/QueueStrip.vue'
import { buildPrompt } from '@/composables/usePi'
import type { QueueMutation, QueueState } from '@/composables/piEvents'

/**
 * #69 M7 队列 strip 呈现层锁：两段渲染与扁平索引坐标系、
 * 拖拽事件 → move 载荷、↑↓/删除 → op、编辑 → editOpen、清空 → clear、
 * 显示文本剥掉 buildPrompt 标记块。
 *
 * jsdom 的 DragEvent 残缺，但组件的 drag 处理器只吃索引参数——
 * 派发普通 Event('dragstart'/'drop') 足够走通状态机。
 */
function mount(queue: QueueState) {
  const emits: Array<{ event: string; args: unknown[] }> = []
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({
    render: () =>
      h(QueueStrip, {
        queue,
        onOp: (...a: unknown[]) => emits.push({ event: 'op', args: a }),
        onEditOpen: (...a: unknown[]) => emits.push({ event: 'editOpen', args: a }),
        onClear: (...a: unknown[]) => emits.push({ event: 'clear', args: a }),
      }),
  })
  app.mount(host)
  return { host, emits, ops: () => emits.filter((e) => e.event === 'op').map((e) => e.args[0] as QueueMutation) }
}

const q = (steer: string[], followUp: string[]): QueueState => ({ steering: steer, followUp })

describe('#69 M7 QueueStrip 渲染与坐标系', () => {
  it('空队列 → 整条不渲染', async () => {
    const { host } = mount(q([], []))
    await nextTick()
    expect(host.querySelector('.queue-strip')).toBeNull()
  })

  it('两段都在 → steer 段在前，条目顺序即扁平索引顺序', async () => {
    const { host } = mount(q(['插一', '插二'], ['排一']))
    await nextTick()
    const items = [...host.querySelectorAll('.queue-item-text')].map((el) => el.textContent)
    expect(items).toEqual(['插一', '插二', '排一'])
    expect(host.querySelectorAll('.queue-seg').length).toBe(2)
  })

  it('显示文本剥附件标记块——用户看不到 buildPrompt 的机器语法', async () => {
    const body = buildPrompt('看图', [{ id: 'a1', path: '/tmp/a.png', name: 'a.png', size: 10, kind: 'image' }])
    const { host } = mount(q([], [body]))
    await nextTick()
    expect(host.querySelector('.queue-item-text')?.textContent).toBe('看图')
  })

  it('首条上移禁用、末条下移禁用（边界不发无效 move）', async () => {
    const { host } = mount(q(['甲', '乙'], []))
    await nextTick()
    const acts = [...host.querySelectorAll('.queue-item')].map((el) =>
      [...el.querySelectorAll<HTMLButtonElement>('.queue-act')].map((b) => b.disabled),
    )
    // [上移, 下移, 编辑, 删除]：首条上移禁，末条下移禁
    expect(acts[0][0]).toBe(true)
    expect(acts[0][1]).toBe(false)
    expect(acts[1][0]).toBe(false)
    expect(acts[1][1]).toBe(true)
  })
})

describe('#69 M7 QueueStrip 事件载荷', () => {
  it('点 ↑↓ → move(from,to) 扁平索引；删除 → remove', async () => {
    const { host, ops } = mount(q(['插一'], ['排一', '排二']))
    await nextTick()
    const items = [...host.querySelectorAll<HTMLElement>('.queue-item')]
    // followUp 首条的扁平索引 = 1（steer 长度 1 偏移）
    const acts = [...items[1].querySelectorAll<HTMLButtonElement>('.queue-act')]
    acts[0].click() // 上移
    acts[3].click() // 删除
    expect(ops()).toEqual([
      { kind: 'move', from: 1, to: 0 },
      { kind: 'remove', at: 1 },
    ])
  })

  it('编辑按钮 → editOpen(扁平索引)，不进 op 流', async () => {
    const { host, emits, ops } = mount(q(['插一'], ['排一']))
    await nextTick()
    const items = [...host.querySelectorAll<HTMLElement>('.queue-item')]
    items[1].querySelectorAll<HTMLButtonElement>('.queue-act')[2].click()
    expect(emits.filter((e) => e.event === 'editOpen').map((e) => e.args[0])).toEqual([1])
    expect(ops()).toEqual([])
  })

  it('拖拽：dragstart 记源、drop 在目标条目 → move；同源落回不发', async () => {
    const { host, ops } = mount(q(['甲', '乙'], ['丙']))
    await nextTick()
    const items = [...host.querySelectorAll<HTMLElement>('.queue-item')]
    items[0].dispatchEvent(new Event('dragstart'))
    items[2].dispatchEvent(new Event('drop'))
    expect(ops()).toEqual([{ kind: 'move', from: 0, to: 2 }])
    // 源清掉后再 drop → 无事件
    items[2].dispatchEvent(new Event('drop'))
    expect(ops().length).toBe(1)
  })

  it('drop 在自己身上 → 原地不动不发事件；dragend 清拖拽态', async () => {
    const { host, ops } = mount(q(['甲'], []))
    await nextTick()
    const item = host.querySelector<HTMLElement>('.queue-item')!
    item.dispatchEvent(new Event('dragstart'))
    item.dispatchEvent(new Event('drop'))
    expect(ops()).toEqual([])
    item.dispatchEvent(new Event('dragend'))
    // dragend 后 drop 无源 → 不发
    item.dispatchEvent(new Event('drop'))
    expect(ops()).toEqual([])
  })

  it('清空按钮 → clear 事件', async () => {
    const { host, emits } = mount(q([], ['排一']))
    await nextTick()
    ;(host.querySelector('.queue-clear') as HTMLElement).click()
    expect(emits.filter((e) => e.event === 'clear').length).toBe(1)
  })
})
