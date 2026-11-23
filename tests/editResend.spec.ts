// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MessageList from '@/components/chat/MessageList.vue'

/**
 * #67 M1/M2 呈现层锁：编辑入口、就地编辑形态、刷新末条按钮的显隐门槛。
 *
 * 编排（rewindTurn + 重派）在 ChatView 里，jsdom 测不到 usePi 的 IPC 半边；
 * 这里锁的是「按钮什么时候出现、点了 emit 什么、编辑态长什么样」——
 * WorkBuddy 口径的可见行为全部在这一层。
 */
const ROOT = '/Users/me/repo'

function mountList(
  list: any[],
  opts: { streaming?: boolean; resending?: boolean } = {},
) {
  const emits: Array<{ event: string; args: any[] }> = []
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({
    render: () =>
      h(MessageList, {
        messages: list,
        streaming: opts.streaming ?? false,
        resending: opts.resending ?? false,
        artifacts: {},
        root: ROOT,
        onEditResend: (...a: any[]) => emits.push({ event: 'edit-resend', args: a }),
        onRegen: (...a: any[]) => emits.push({ event: 'regen', args: a }),
      }),
  })
  app.mount(host)
  return { host, emits }
}

const user = (id: string, text: string, turnSeq?: number) => ({
  id,
  role: 'user',
  text,
  ts: Date.now(),
  ...(turnSeq ? { turnSeq } : {}),
})
const assist = (id: string, text: string) => ({ id, role: 'assistant', text })

describe('#67 M1 编辑入口', () => {
  it('带 checkpoint 的 user 消息有「编辑」按钮，没有 turnSeq 的不出现', async () => {
    const { host } = mountList([
      user('u1', '有 checkpoint', 1),
      assist('a1', '回复一'),
      user('u2', '回放消息没有 seq'),
      assist('a2', '回复二'),
    ])
    await nextTick()
    const btns = host.querySelectorAll('.edit-btn')
    expect(btns.length).toBe(1)
    expect(btns[0]?.closest('.msg-row')?.textContent).toContain('有 checkpoint')
  })

  it('点编辑 → 原位换成编辑区：气泡与操作行隐藏，提示语在位', async () => {
    const { host } = mountList([user('u1', '原文', 1), assist('a1', '回复')])
    await nextTick()
    ;(host.querySelector('.edit-btn') as HTMLElement).click()
    await nextTick()
    expect(host.querySelector('.edit-box')).toBeTruthy()
    expect(host.querySelector('.edit-hint')?.textContent).toContain('编辑后将从此处重新开始对话')
    // 原位替换：气泡本体与 hover 操作行都不在编辑态渲染
    expect(host.querySelector('.msg-row.user .txt')).toBeFalsy()
    expect(host.querySelector('.msg-row.user .user-actions')).toBeFalsy()
    // 编辑框预填原文
    expect((host.querySelector('.edit-area') as HTMLTextAreaElement).value).toBe('原文')
  })

  it('提交 → emit edit-resend 带 id 与新文本；取消 → 恢复原形态且不 emit', async () => {
    const { host, emits } = mountList([user('u1', '原文', 1), assist('a1', '回复')])
    await nextTick()
    ;(host.querySelector('.edit-btn') as HTMLElement).click()
    await nextTick()
    const ta = host.querySelector('.edit-area') as HTMLTextAreaElement
    ta.value = '改过的文本'
    ta.dispatchEvent(new Event('input'))
    await nextTick()
    ;(host.querySelector('.edit-resend') as HTMLElement).click()
    await nextTick()
    const edit = emits.filter((e) => e.event === 'edit-resend')
    expect(edit.length).toBe(1)
    expect(edit[0].args[0]).toMatchObject({ id: 'u1', text: '改过的文本' })
    // 提交后编辑区收起，气泡回到原样（重派由 ChatView 完成，呈现层不管）
    expect(host.querySelector('.edit-box')).toBeFalsy()

    // 取消路径：不产生任何事件，形态还原
    ;(host.querySelector('.edit-btn') as HTMLElement).click()
    await nextTick()
    expect(host.querySelector('.edit-box')).toBeTruthy()
    ;(host.querySelector('.edit-cancel') as HTMLElement).click()
    await nextTick()
    expect(host.querySelector('.edit-box')).toBeFalsy()
    expect(emits.filter((e) => e.event === 'edit-resend').length).toBe(1)
  })

  it('清空正文且无附件/引用 → 提交按钮禁用（不发空消息）', async () => {
    const { host, emits } = mountList([user('u1', '原文', 1), assist('a1', '回复')])
    await nextTick()
    ;(host.querySelector('.edit-btn') as HTMLElement).click()
    await nextTick()
    const ta = host.querySelector('.edit-area') as HTMLTextAreaElement
    ta.value = '   '
    ta.dispatchEvent(new Event('input'))
    await nextTick()
    const send = host.querySelector('.edit-resend') as HTMLButtonElement
    expect(send.disabled).toBe(true)
    send.click()
    await nextTick()
    expect(emits.filter((e) => e.event === 'edit-resend').length).toBe(0)
  })

  it('流式中编辑按钮禁用；resending 在途时入口整体锁死', async () => {
    const { host } = mountList([user('u1', '原文', 1), assist('a1', '回复')], { streaming: true })
    await nextTick()
    expect((host.querySelector('.edit-btn') as HTMLButtonElement).disabled).toBe(true)
        const { host: h2 } = mountList([user('u1', '原文', 1), assist('a1', '回复')], { resending: true })
    await nextTick()
    // 回滚在途：编辑与回到此处都点不动（disabled 而非隐藏——按钮还在才看得见入口）
    expect((h2.querySelector('.edit-btn') as HTMLButtonElement).disabled).toBe(true)
    expect((h2.querySelector('.rewind-btn') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('#67 M2 刷新末条', () => {
  it('仅末尾轮操作行有刷新键，且归属提问须带 checkpoint', async () => {
    const { host } = mountList([
      user('u1', '第一条', 1),
      assist('a1', '回复一'),
      user('u2', '第二条', 2),
      assist('a2', '回复二'),
    ])
    await nextTick()
    const regen = host.querySelectorAll('.regen-btn')
    expect(regen.length).toBe(1)
    // 挂在最后一轮的回复上
    const rows = host.querySelectorAll('.msg-row.assistant')
    expect(rows[rows.length - 1]?.contains(regen[0])).toBe(true)
  })

  it('归属提问没有 checkpoint（回放会话）→ 刷新键不出现', async () => {
    const { host } = mountList([user('u1', '回放消息'), assist('a1', '回复')])
    await nextTick()
    expect(host.querySelectorAll('.regen-btn').length).toBe(0)
  })

  it('点刷新 → emit regen 带归属提问整条消息（id/turnSeq/text）', async () => {
    const { host, emits } = mountList([user('u1', '原始提问', 1), assist('a1', '回复')])
    await nextTick()
    ;(host.querySelector('.regen-btn') as HTMLElement).click()
    await nextTick()
    const regen = emits.filter((e) => e.event === 'regen')
    expect(regen.length).toBe(1)
    expect(regen[0].args[0]).toMatchObject({ id: 'u1', turnSeq: 1, text: '原始提问' })
  })

  it('流式中刷新键禁用（本轮还在跑，撤它等于掐断它）', async () => {
    const { host } = mountList([user('u1', '提问', 1), assist('a1', '回复')], { streaming: true })
    await nextTick()
    const btn = host.querySelector('.regen-btn') as HTMLButtonElement | null
    // 流式中末尾 turn 的 live 态不渲染操作行（v-if="!row.live"）——两种形态都算锁死
    if (btn) expect(btn.disabled).toBe(true)
    else expect(host.querySelector('.turn-status')).toBeTruthy()
  })

  it('末尾是裸 user 消息（无回复）→ 没有可刷新的回复', async () => {
    const { host } = mountList([user('u1', '提问', 1), assist('a1', '回复'), user('u2', '又一条', 2)])
    await nextTick()
    expect(host.querySelectorAll('.regen-btn').length).toBe(0)
  })
})
