import { describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import {
  PI_SESSION_ID,
  describeProjectError,
  taskContextPreamble,
  type CapabilityRef,
  type TaskContext,
} from '@/composables/useProject'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

function ctx(): TaskContext {
  return {
    project: { id: 'p1', name: '登录页重构' },
    config: {
      id: 'cfg2',
      project_id: 'p1',
      number: 2,
      instruction: '按团队规范输出，代码要带测试。',
      capabilities: [{ kind: 'skill', id: 'pdf-tools', label: 'PDF' }],
      created_by: 'local',
      created_at: 1,
    },
    task: {
      id: 't1',
      project_id: 'p1',
      session_id: PI_SESSION_ID,
      title: '重构登录',
      config_revision_id: 'cfg2',
      capabilities: [{ kind: 'skill', id: 'pdf-tools', label: 'PDF' }],
      references: [{ kind: 'work-item', id: 'w1', revision: 'r1', label: '登录页' }],
      created_at: 1,
    },
  }
}

describe('describeProjectError · 领域错误码翻译', () => {
  it('把 revision 冲突翻成用户能执行的提示', () => {
    expect(describeProjectError({ message: 'projects/revision-conflict' })).toContain('刷新')
  })

  it('超预算时提示精简而不是甩错误码', () => {
    expect(describeProjectError(new Error('projects/instruction-budget-exceeded'))).toContain('精简')
  })

  it('未知错误保留兜底文案', () => {
    expect(describeProjectError(new Error('boom'), '操作失败')).toBe('操作失败')
  })
})

describe('taskContextPreamble · 会话上下文注入', () => {
  it('无绑定会话时不注入任何东西', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(null)
    expect(await taskContextPreamble('unknown')).toBe('')
  })

  it('带上项目名、修订号、指令与本次引用的能力', async () => {
    vi.mocked(invoke).mockResolvedValueOnce(ctx())
    const out = await taskContextPreamble(PI_SESSION_ID)
    expect(out).toContain('[项目] 登录页重构')
    expect(out).toContain('[配置修订 #2]')
    expect(out).toContain('按团队规范输出')
    expect(out).toContain('[本次可用能力] PDF')
    expect(out).toContain('[本次引用] 登录页')
  })

  it('内核不可用时静默降级，不阻断会话', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('IPC down'))
    expect(await taskContextPreamble(PI_SESSION_ID)).toBe('')
  })
})

describe('能力绑定解析', () => {
  it('从 kind:id 文本行解析出结构化引用', () => {
    const lines = 'skill:pdf-tools 解析 PDF\nexpert:reviewer 代码评审'
    const caps: CapabilityRef[] = lines
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [head, ...rest] = line.split(/\s+/)
        const [kind, id] = head.split(':')
        return { kind: kind || 'skill', id: id || head, label: rest.join(' ') || id || head }
      })
    expect(caps).toEqual([
      { kind: 'skill', id: 'pdf-tools', label: '解析 PDF' },
      { kind: 'expert', id: 'reviewer', label: '代码评审' },
    ])
  })
})
