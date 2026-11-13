// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import ExpertImportDialog from '@/components/experts/ExpertImportDialog.vue'
import { resolveImportedTools, type ExpertDefinition, type ImportPreview } from '@/composables/useExperts'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const mockedInvoke = vi.mocked(invoke)

const definition: ExpertDefinition = {
  name: '调查员',
  description: '调查代码库里的调用链',
  role: '你是代码小队里的调查员。',
  methodology: '先定位入口。',
  boundaries: '❌ 不修改文件',
  deliverables: '调用链与结论',
  tags: ['代码'],
  examples: [],
  skill_requirements: [],
  allowed_tools: ['read_file', 'bash'],
  denied_patterns: [],
  stop_condition: '状态 done 时返回。',
  max_iterations: null,
}

function preview(conflict: boolean): ImportPreview {
  return {
    source: '/tmp/code-crew',
    plugin: '/tmp/code-crew/.codebuddy-plugin/plugin.json',
    unmapped_fields: [{ field: 'skills', reason: '技能引用未映射。' }],
    experts: [
      {
        id: 'code-investigator',
        name: '调查员',
        role: definition.role,
        definition,
        source_path: '/tmp/code-crew/.codebuddy-plugin/agents/investigator.md',
        conflict,
        unmapped_tools: [{ name: 'read_file', suggestion: 'read' }],
        unmapped_fields: [],
        warnings: [],
      },
    ],
  }
}

async function flush() {
  await new Promise((r) => setTimeout(r, 0))
  await nextTick()
  await new Promise((r) => setTimeout(r, 0))
}

/** 打开第一个未映射工具的下拉，选中指定项。 */
async function decideTool(label: string) {
  const trigger = document.querySelector<HTMLButtonElement>('.import-tool-row .trigger')!
  trigger.click()
  await flush()
  const opt = [...document.querySelectorAll<HTMLElement>('.app-select .opt')].find((el) =>
    el.textContent?.includes(label),
  )!
  opt.click()
  await flush()
}

function applyButton(): HTMLButtonElement {
  return [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.includes('导入 '),
  )!
}

function appliedItems() {
  const call = mockedInvoke.mock.calls.find(([cmd]) => cmd === 'expert_import_apply')
  return (call?.[1] as { items: { id: string; definition: ExpertDefinition }[] }).items
}

async function mountDialog() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({
    render: () =>
      h(ExpertImportDialog, { open: true, existingIds: ['code-investigator'] }),
  })
  app.mount(host)
  await flush()
  return { host, app }
}

async function previewOnce(host: HTMLElement) {
  const input = host.ownerDocument.querySelector<HTMLInputElement>('.import-path input')!
  input.value = '/tmp/code-crew'
  input.dispatchEvent(new Event('input'))
  await flush()
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.includes('识别并预览'),
  )!
  button.click()
  await flush()
}

beforeEach(() => {
  vi.clearAllMocks()
  Element.prototype.scrollIntoView = vi.fn()
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'tools_list') return { active: [], catalog: ['read', 'bash', 'grep'], settings_path: '' }
    if (cmd === 'expert_import_preview') return preview(false)
    if (cmd === 'expert_import_apply') return []
    return null
  })
})

describe('resolveImportedTools', () => {
  it('按映射替换、忽略空值并去重，保持顺序，同时留下决策记录', () => {
    const def = { ...definition, allowed_tools: ['read_file', 'bash', 'read_file', 'web_search'] }
    const resolved = resolveImportedTools(def, { read_file: 'read', web_search: '' })
    expect(resolved.allowed_tools).toEqual(['read', 'bash'])
    expect(resolved.tool_mapping).toEqual([
      { from: 'read_file', to: 'read', decision: 'mapped' },
      { from: 'web_search', to: null, decision: 'ignored' },
    ])
    expect(def.allowed_tools).toEqual(['read_file', 'bash', 'read_file', 'web_search'])
  })

  it('没有映射时保留原名', () => {
    expect(resolveImportedTools(definition, {}).allowed_tools).toEqual(['read_file', 'bash'])
  })
})

describe('ExpertImportDialog', () => {
  it('预览列出未映射工具与未映射字段，并显示待处理项', async () => {
    const { host, app } = await mountDialog()
    await previewOnce(host)
    const text = document.body.textContent ?? ''
    expect(text).toContain('识别到 1 个专家')
    expect(text).toContain('read_file')
    expect(text).toContain('技能引用未映射')
    expect(text).toContain('还有 1 项未映射工具待处理')
    expect(document.querySelectorAll('.import-tool-row').length).toBe(1)
    expect(document.getElementById('import-tool-code-investigator-read_file')).not.toBeNull()
    app.unmount()
    host.remove()
  })

  it('未决定前导入按钮不可用，点不动', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'tools_list') return { active: [], catalog: ['read', 'bash'], settings_path: '' }
      if (cmd === 'expert_import_preview') return preview(false)
      if (cmd === 'expert_import_apply') return [{ id: 'code-investigator', action: 'created', source_path: '/tmp' }]
      return []
    })
    const { host, app } = await mountDialog()
    await previewOnce(host)

    const apply = applyButton()
    expect(apply.disabled).toBe(true)
    apply.click()
    await flush()
    expect(mockedInvoke).not.toHaveBeenCalledWith('expert_import_apply', expect.anything())
    app.unmount()
    host.remove()
  })

  it('待处理项可一键跳转', async () => {
    const { host, app } = await mountDialog()
    await previewOnce(host)
    const jump = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('read_file'),
    )!
    jump.click()
    await flush()
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    app.unmount()
    host.remove()
  })

  it('冲突默认跳过：点导入不会写入任何草稿', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'tools_list') return { active: [], catalog: ['read', 'bash'], settings_path: '' }
      if (cmd === 'expert_import_preview') return preview(true)
      return []
    })
    const { host, app } = await mountDialog()
    await previewOnce(host)
    expect(document.body.textContent).toContain('同名专家已存在')

    applyButton().click()
    await flush()
    expect(mockedInvoke).not.toHaveBeenCalledWith('expert_import_apply', expect.anything())
    app.unmount()
    host.remove()
  })

  it('显式忽略后才可导入：工具被移出允许集，并留下 ignored 记录', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'tools_list') return { active: [], catalog: ['read', 'bash'], settings_path: '' }
      if (cmd === 'expert_import_preview') return preview(false)
      if (cmd === 'expert_import_apply') return [{ id: 'code-investigator', action: 'created', source_path: '/tmp' }]
      return []
    })
    const { host, app } = await mountDialog()
    await previewOnce(host)
    await decideTool('忽略该工具')

    const apply = applyButton()
    expect(apply.disabled).toBe(false)
    apply.click()
    await flush()
    const items = appliedItems()
    expect(items[0].id).toBe('code-investigator')
    expect(items[0].definition.allowed_tools).toEqual(['bash'])
    expect(items[0].definition.tool_mapping).toEqual([
      { from: 'read_file', to: null, decision: 'ignored' },
    ])
    app.unmount()
    host.remove()
  })

  it('指定替代工具后可导入：映射结果与记录一起写入定义', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'tools_list') return { active: [], catalog: ['read', 'bash'], settings_path: '' }
      if (cmd === 'expert_import_preview') return preview(false)
      if (cmd === 'expert_import_apply') return [{ id: 'code-investigator', action: 'created', source_path: '/tmp' }]
      return []
    })
    const { host, app } = await mountDialog()
    await previewOnce(host)
    await decideTool('建议映射')

    const apply = applyButton()
    expect(apply.disabled).toBe(false)
    apply.click()
    await flush()
    const items = appliedItems()
    expect(items[0].definition.allowed_tools).toEqual(['read', 'bash'])
    expect(items[0].definition.tool_mapping).toEqual([
      { from: 'read_file', to: 'read', decision: 'mapped' },
    ])
    app.unmount()
    host.remove()
  })
})
