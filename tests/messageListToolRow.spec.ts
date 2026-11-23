// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MessageList from '@/components/chat/MessageList.vue'

/**
 * 工具行的真实挂载用例（呈现层验收：折叠行显示语义摘要，参数 JSON 只在展开体里）。
 *
 * 摘要算法本身在 toolSummary.spec.ts 里逐条对拍；这里锁的是「MessageList 真的
 * 用上了它」——上一版直接把 `{"command":"ls -la /abs/path"}` 摊在行上，
 * 纯函数测试完全测不出这种接错线的情况。
 */
const ROOT = '/Users/me/repo'

const msgs = [
  { id: 'u1', role: 'user', text: '跑个命令' },
  {
    id: 't1',
    role: 'assistant',
    text: '',
    tool: 'bash',
    toolCallId: 'c1',
    toolArgs: `{"command":"ls -la ${ROOT}/src","description":"列目录"}`,
    toolResult: 'total 8',
  },
  {
    id: 't2',
    role: 'assistant',
    text: '',
    tool: 'read',
    toolCallId: 'c2',
    toolArgs: `{"path":"${ROOT}/src/a.ts"}`,
  },
  {
    id: 't3',
    role: 'assistant',
    text: '',
    tool: 'mcp__db__query',
    toolCallId: 'c3',
    toolArgs: '{"sql":"select 1"}',
    toolError: 'boom',
  },
  {
    id: 't4',
    role: 'assistant',
    text: '',
    fileChanges: [
      {
        id: 'call-1',
        tool: 'edit' as const,
        path: `${ROOT}/src/a.ts`,
        edits: [{ oldText: 'a', newText: 'b' }],
        content: null,
      },
    ],
  },
]

function mountList(streaming = false, list = msgs) {
  const errors: unknown[] = []
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({
    render: () => h(MessageList, { messages: list, streaming, artifacts: {}, root: ROOT }),
  })
  app.config.errorHandler = (e) => errors.push(e)
  app.mount(host)
  return { host, errors }
}

/** 过程折叠头同样复用 `.crow`，但它是本轮工具的汇总行，不算工具行。 */
const toolRowsOf = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('.crow:not(.proc-head)')]
const titleOf = (row: HTMLElement) => row.querySelector('.crow-title')?.textContent ?? ''
const summaryOf = (row: HTMLElement) => row.querySelector('.crow-summary')?.textContent ?? ''

describe('MessageList 工具行', () => {
  it('折叠行是「标题 · 摘要」，整列不出现参数 JSON', async () => {
    const { host, errors } = mountList()
    await nextTick()

    expect(errors).toEqual([])
    // 本轮 3 个工具行 ≥ 阈值，先有一行「过程」汇总头（≥3 步才折叠，见 procCollapsible）
    expect(host.querySelector('.proc-head .crow-title')?.textContent).toBe('过程')
    expect(host.querySelector('.proc-head .crow-summary')?.textContent).toBe('3 步工具调用')
    const rows = toolRowsOf(host)
    expect(rows.map(titleOf)).toEqual(['Bash', 'Read', 'Tool call'])
    // bash 取 description（dsh SUMMARY_KEYS 顺序），read 取 path 且削掉工作区前缀
    expect(rows.map(summaryOf)).toEqual(['列目录', 'src/a.ts', 'mcp__db__query · select 1'])
    expect(host.textContent).not.toContain('"command"')
    expect(host.textContent).not.toContain(ROOT)
  })

  it('展开体里参数按语义分块（命令原文 + 结果同列），复制贴结果块右上角', async () => {
    const { host } = mountList()
    await nextTick()
    const bash = toolRowsOf(host).find((r) => titleOf(r) === 'Bash')!
    bash.querySelector<HTMLButtonElement>('.crow-head')!.click()
    await nextTick()

    const labels = [...bash.querySelectorAll('.crow-label')].map((n) => n.textContent)
    expect(labels).toEqual(['命令', '结果'])
    const body = bash.querySelector('.crow-body')!.textContent ?? ''
    // 花括号只该出现在「取不到已知字段」的回落里；bash 的命令块不该有
    expect(body).not.toContain('"command"')
    expect(body).toContain('ls -la /Users/me/repo/src')
    expect(bash.querySelector('.crow-out')!.textContent).toContain('total 8')
    expect(bash.querySelector('.crow-out .crow-copy')).not.toBeNull()
  })

  it('未知工具取不到已知字段才回落缩进 JSON（dsh deriveBody 兜底仍在）', async () => {
    const { host } = mountList()
    await nextTick()
    // 失败行由 CollapsibleRow 自动展开（F8），这里直接读展开体
    const unknown = toolRowsOf(host).find((r) => titleOf(r) === 'Tool call')!
    await nextTick()

    expect(unknown.querySelector('.crow-label')!.textContent).toBe('参数')
    expect(unknown.querySelector('.crow-body')!.textContent).toContain('{\n  "sql": "select 1"')
  })

  it('执行失败的工具行带 error 语义色，未知工具保留原始工具名', async () => {
    const { host } = mountList()
    await nextTick()
    const failed = toolRowsOf(host).find((r) => titleOf(r) === 'Tool call')!
    expect(failed.className).toContain('is-error')
    expect(failed.querySelector('.crow-icon')).not.toBeNull()
  })

  it('本轮未落定：无结果的工具行标 running，失败的标 error，已完成的无状态', async () => {
    const { host } = mountList(true)
    await nextTick()
    const rows = toolRowsOf(host)
    expect(rows[0].getAttribute('data-state')).toBeNull()
    expect(rows[1].getAttribute('data-state')).toBe('running')
    expect(rows[2].getAttribute('data-state')).toBe('error')
    // 状态行是 role=status 的实时播报区，本轮跑完就消失（操作行取而代之）
    expect(host.querySelector('.turn-status')?.getAttribute('aria-live')).toBe('polite')
    expect(host.querySelector('.turn-actions')).toBeNull()
  })

  it('落定后操作行出现，本轮正文可一把复制', async () => {
    const { host } = mountList()
    await nextTick()
    const actions = host.querySelector('.turn-actions')!
    expect(actions).not.toBeNull()
    expect(actions.getAttribute('data-actions-reveal')).toBe('always')
    expect(host.querySelector('.turn-status')).toBeNull()
    expect(actions.querySelector<HTMLButtonElement>('.ta-btn')?.disabled).toBe(true)
  })

  it('系统文本渲染成 notice 行：失败进 danger 档，重试进度保持中性档', async () => {
    const { host } = mountList(false, [
      { id: 's1', role: 'system', text: '模型请求失败：上游 429 rate limit exceeded' },
      { id: 's2', role: 'system', text: '模型请求失败，自动重试中（第 3 次，8s 后）…' },
      { id: 's3', role: 'system', text: '计划模式：未解析到分步计划，已按普通回复处理。' },
    ])
    await nextTick()
    const notes = [...host.querySelectorAll<HTMLElement>('.msg-row.system')]
    expect(notes).toHaveLength(3)
    // 「失败」在前、「重试中」优先于失败档：重试是进行中，不该染成报错色
    expect(notes[0].className).toContain('sys-error')
    expect(notes[1].className).toContain('sys-muted')
    expect(notes[2].className).toContain('sys-warn')
    expect(host.querySelector('.sys-line')).toBeNull()
    expect(host.querySelectorAll('.sys-ic svg')).toHaveLength(3)
    expect(host.querySelector('.sys-note')).not.toBeNull()
  })

  it('文件改动：汇总行 + chip 只显末端名，点开 chip 才出该文件的 diff', async () => {
    const { host } = mountList()
    await nextTick()
    const files = host.querySelector('.msg-files')!
    expect(files.querySelector('.files-head')?.textContent).toContain('本轮文件改动 · 1')
    expect(files.querySelector('.files-sum')?.textContent).toContain('+1')
    expect(files.querySelector('.file-diff-block')).toBeNull()

    const chip = files.querySelector<HTMLButtonElement>('.file-chip')!
    expect(chip.textContent).toContain('a.ts')
    expect(chip.textContent).not.toContain(ROOT)

    chip.click()
    await nextTick()
    const block = files.querySelector('.file-diff-block')!
    // 展开体里的路径削掉工作区前缀，diff 行是 +b / -a
    expect(block.querySelector('.file-diff-path')?.textContent).toBe('src/a.ts')
    expect(block.querySelector('.file-diff')?.textContent).toContain('+b')
  })
})
