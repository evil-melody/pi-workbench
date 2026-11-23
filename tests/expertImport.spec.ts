// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import ExpertImportDialog from '@/components/experts/ExpertImportDialog.vue'
import { resolveImportedTools, type ExpertDefinition, type ImportPreview, type ScanResult } from '@/composables/useExperts'

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

function preview(
  conflict: boolean,
  tools: Array<{ name: string; suggestion: string | null }> = [{ name: 'read_file', suggestion: 'read' }],
): ImportPreview {
  return {
    source: '/tmp/code-crew',
    plugin: '/tmp/code-crew/.codebuddy-plugin/plugin.json',
    unmapped_fields: [{ field: 'skills', reason: '技能引用未映射。' }],
    experts: [
      {
        id: 'code-investigator',
        name: '调查员',
        role: definition.role,
        definition: tools.some((t2) => t2.name === 'grep_files')
          ? { ...definition, allowed_tools: ['grep_files', 'bash'] }
          : definition,
        source_path: '/tmp/code-crew/.codebuddy-plugin/agents/investigator.md',
        conflict,
        unmapped_tools: tools,
        unmapped_fields: [],
        warnings: [],
      },
    ],
  }
}

function scan(packs: ScanResult['packages'] = []): ScanResult {
  return { root: '/Users/dev/.workbuddy/plugins/cache/experts', packages: packs }
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

/** 备选入口：手填路径 → 识别并预览 → 明细态。 */
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

/** 主路径：扫描清单勾选包 → 「预览 N 个包」 → 明细态。 */
async function previewViaScan(host: HTMLElement) {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
    b.textContent?.includes('预览 '),
  )!
  button.click()
  await flush()
}

beforeEach(() => {
  vi.clearAllMocks()
  Element.prototype.scrollIntoView = vi.fn()
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'tools_list') return { active: [], catalog: ['read', 'bash', 'grep'], settings_path: '' }
    if (cmd === 'expert_import_scan') return scan()
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
  it('预览列出未映射工具与未映射字段，决策自动采纳（不再挂待处理）', async () => {
    const { host, app } = await mountDialog()
    await previewOnce(host)
    const text = document.body.textContent ?? ''
    expect(text).toContain('识别到 1 个专家')
    expect(text).toContain('read_file')
    expect(text).toContain('技能引用未映射')
    // 新契约：有建议自动采纳、无建议自动忽略——不存在「待处理」横幅。
    expect(text).not.toContain('未映射工具待处理')
    expect(text).toContain('有建议的已自动采纳')
    expect(document.querySelectorAll('.import-tool-row').length).toBe(1)
    expect(document.getElementById('import-tool-code-investigator-read_file')).not.toBeNull()
    // 采纳后允许集已是 read，而不是外部名 read_file。
    expect(text).toContain('工具：read、bash')
    app.unmount()
    host.remove()
  })

  it('自动采纳后可直接导入：映射结果与记录一起写入定义', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'tools_list') return { active: [], catalog: ['read', 'bash'], settings_path: '' }
      if (cmd === 'expert_import_scan') return scan()
      if (cmd === 'expert_import_preview') return preview(false)
      if (cmd === 'expert_import_apply') return [{ id: 'code-investigator', action: 'created', source_path: '/tmp' }]
      return []
    })
    const { host, app } = await mountDialog()
    await previewOnce(host)

    const apply = applyButton()
    expect(apply.disabled).toBe(false)
    apply.click()
    await flush()
    const items = appliedItems()
    expect(items[0].id).toBe('code-investigator')
    expect(items[0].definition.allowed_tools).toEqual(['read', 'bash'])
    expect(items[0].definition.tool_mapping).toEqual([
      { from: 'read_file', to: 'read', decision: 'mapped' },
    ])
    app.unmount()
    host.remove()
  })

  it('无建议的工具自动忽略：移出允许集并留下 ignored 记录', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'tools_list') return { active: [], catalog: ['read', 'bash'], settings_path: '' }
      if (cmd === 'expert_import_scan') return scan()
      if (cmd === 'expert_import_preview') return preview(false, [{ name: 'grep_files', suggestion: null }])
      if (cmd === 'expert_import_apply') return [{ id: 'code-investigator', action: 'created', source_path: '/tmp' }]
      return []
    })
    const { host, app } = await mountDialog()
    await previewOnce(host)

    const apply = applyButton()
    expect(apply.disabled).toBe(false)
    apply.click()
    await flush()
    const items = appliedItems()
    expect(items[0].definition.allowed_tools).toEqual(['bash'])
    expect(items[0].definition.tool_mapping).toEqual([
      { from: 'grep_files', to: null, decision: 'ignored' },
    ])
    app.unmount()
    host.remove()
  })

  it('可手动改决策：把自动采纳的映射改成忽略', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'tools_list') return { active: [], catalog: ['read', 'bash'], settings_path: '' }
      if (cmd === 'expert_import_scan') return scan()
      if (cmd === 'expert_import_preview') return preview(false)
      if (cmd === 'expert_import_apply') return [{ id: 'code-investigator', action: 'created', source_path: '/tmp' }]
      return []
    })
    const { host, app } = await mountDialog()
    await previewOnce(host)
    await decideTool('忽略（内核没有）')

    const apply = applyButton()
    expect(apply.disabled).toBe(false)
    apply.click()
    await flush()
    const items = appliedItems()
    expect(items[0].definition.allowed_tools).toEqual(['bash'])
    expect(items[0].definition.tool_mapping).toEqual([
      { from: 'read_file', to: null, decision: 'ignored' },
    ])
    app.unmount()
    host.remove()
  })

  it('冲突默认跳过：导入 0 个专家，点导入不写入任何草稿', async () => {
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'tools_list') return { active: [], catalog: ['read', 'bash'], settings_path: '' }
      if (cmd === 'expert_import_scan') return scan()
      if (cmd === 'expert_import_preview') return preview(true)
      return []
    })
    const { host, app } = await mountDialog()
    await previewOnce(host)
    expect(document.body.textContent).toContain('同名专家已存在')
    expect(applyButton().textContent).toContain('导入 0 个专家')

    applyButton().click()
    await flush()
    expect(mockedInvoke).not.toHaveBeenCalledWith('expert_import_apply', expect.anything())
    app.unmount()
    host.remove()
  })

  it('主路径：扫描清单勾选包 → 预览入明细 → 逐包走 preview', async () => {
    const pack = {
      slug: 'code-crew',
      name: '代码小队',
      version: '1.0.0',
      path: '/tmp/code-crew',
      is_team: false,
      lead: null,
      member_ids: [],
      experts: preview(false).experts,
      conflict: false,
      error: null,
    }
    mockedInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'tools_list') return { active: [], catalog: ['read', 'bash'], settings_path: '' }
      if (cmd === 'expert_import_scan') return scan([pack])
      if (cmd === 'expert_import_preview') return preview(false)
      return []
    })
    const { host, app } = await mountDialog()
    // 扫描态：默认全选，包名与计数可见。
    const scanText = document.body.textContent ?? ''
    expect(scanText).toContain('代码小队')
    expect(scanText).toContain('1 位专家')

    await previewViaScan(host)
    // 明细态：走的是逐包 preview 链路，路径来自包本身。
    expect(document.body.textContent).toContain('识别到 1 个专家')
    expect(mockedInvoke).toHaveBeenCalledWith(
      'expert_import_preview',
      expect.objectContaining({ path: '/tmp/code-crew' }),
    )
    // 返回清单可退回扫描态。
    const back = [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('返回清单'),
    )!
    back.click()
    await flush()
    expect(document.body.textContent).toContain('扫描目录')
    app.unmount()
    host.remove()
  })
})
