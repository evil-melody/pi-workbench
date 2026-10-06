import { invoke } from '@tauri-apps/api/core'
import { ref } from 'vue'

export interface Project {
  id: string
  name: string
  description?: string
  template_id?: string
  path?: string
  archived?: boolean
  config_revision_id?: string
  created_at?: number
  updated_at?: number
  /// codebase-memory-mcp 为该目录生成的项目名。
  codebase_project_name?: string
  /// 索引节点数。
  codebase_nodes?: number
  /// 索引边数。
  codebase_edges?: number
  /// 最近成功索引的时间戳。
  codebase_indexed_at?: number
  /// 最近一次索引失败的错误文本。
  codebase_index_error?: string
}

/** 代码库索引状态：前端据此画「在索引 / 成功 / 失败」三态。 */
export interface CodebaseIndexStatus {
  project_id: string
  project_name: string
  status: 'none' | 'indexing' | 'indexed' | 'error'
  nodes: number
  edges: number
  indexed_at: number
  error?: string | null
}

export interface ProjectTemplate {
  id: string
  name: string
  description: string
  instruction: string
}

export interface CapabilityRef {
  kind: string
  id: string
  revision?: string
  label: string
  scope?: string
}

export interface ConfigRevision {
  id: string
  project_id: string
  number: number
  instruction: string
  capabilities: CapabilityRef[]
  created_by: string
  created_at: number
}

export interface WorkItem {
  id: string
  project_id: string
  title: string
  status: string
  assignee?: string
  priority: string
  tags: string[]
  revision: string
  created_at: number
  updated_at: number
}

export interface AssetRef {
  id: string
  project_id: string
  node_id: string
  asset_id: string
  revision_id: string
  name: string
  kind: string
  created_at: number
}

export interface InputRef {
  kind: string
  id: string
  revision: string
  label: string
}

export interface TaskLink {
  id: string
  project_id: string
  session_id: string
  title: string
  config_revision_id: string
  capabilities?: CapabilityRef[]
  work_item_id?: string
  references: InputRef[]
  created_at: number
}

export interface Activity {
  id: string
  project_id: string
  kind: string
  text: string
  created_at: number
}

export interface InstructionUsage {
  tokens: number
  budget: number
}

export interface ProjectSnapshot {
  project: Project
  config?: ConfigRevision
  work_items: WorkItem[]
  assets: AssetRef[]
  tasks: TaskLink[]
  activity: Activity[]
  instruction_usage: InstructionUsage
}

export interface AssetInput {
  node_id: string
  asset_id: string
  revision_id: string
  name: string
  kind: string
}

export interface WorkItemPatch {
  id: string
  title?: string
  status?: string
  assignee?: string
  priority?: string
  tags?: string[]
}

export interface TaskContext {
  available_capabilities?: CapabilityRef[]
  project: Project
  config: ConfigRevision
  task: TaskLink
}

/** 当前活动项目路径（供终端 / 沙箱确定 cwd）。 */
export const activeProjectPath = ref('')
export const activeProjectId = ref<string | null>(null)

export const WORK_ITEM_STATUS = [
  { value: 'todo', label: '待办' },
  { value: 'doing', label: '进行中' },
  { value: 'review', label: '评审中' },
  { value: 'done', label: '已完成' },
  { value: 'cancelled', label: '已取消' },
]

export function workItemStatusLabel(status: string) {
  return WORK_ITEM_STATUS.find((s) => s.value === status)?.label ?? status
}

export function loadActiveProject() {
  return invoke<string | null>('project_active')
    .then((id) => {
      activeProjectId.value = id
      return id
    })
    .catch(() => null)
    .then(async (id) => {
      if (!id) {
        activeProjectPath.value = ''
        return
      }
      const list = await invoke<Project[]>('projects_list').catch(() => [])
      activeProjectPath.value = list.find((p) => p.id === id)?.path ?? ''
    })
}

/** 后端模板清单：项目模板 id 的唯一来源，前端不再维护第二份。 */
export const loadTemplates = () => invoke<ProjectTemplate[]>('projects_templates')

/**
 * 切活动项目：落库 + 刷新共享状态。
 *
 * Sidebar 与 ChatView 都可能切项目，而 `/chat` 已经挂载时 `router.push('/chat')`
 * 不会重新挂载组件 —— 只改各自组件内的局部状态就会出现「侧栏高亮了，
 * 对话页还停在旧目录」。两边读同一个 ref，ChatView 用 watcher 跟着走。
 */
export async function activateProject(id: string) {
  await invoke('project_set_active', { id }).catch(() => {})
  await loadActiveProject()
}

export const createProject = (
  name: string,
  description = '',
  templateId?: string,
  path?: string,
) =>
  invoke<ProjectSnapshot>('project_add', {
    name,
    description,
    templateId: templateId ?? null,
    path: path ?? null,
  })

export const updateProjectConfig = (
  id: string,
  instruction: string,
  capabilities: CapabilityRef[],
  expectedRevisionId: string,
  expectedRevisionNumber: number,
) =>
  invoke<ProjectSnapshot>('project_update_config', {
    id,
    instruction,
    capabilities,
    expectedRevisionId,
    expectedRevisionNumber,
  })

export const addWorkItem = (id: string, title: string) =>
  invoke<ProjectSnapshot>('project_add_work_item', { id, title })

export const updateWorkItem = (id: string, patch: WorkItemPatch, expectedRevision: string) =>
  invoke<ProjectSnapshot>('project_update_work_item', {
    id,
    patch,
    expectedRevision,
  })

export const removeWorkItem = (id: string, workItemId: string) =>
  invoke<ProjectSnapshot>('project_remove_work_item', { id, workItemId })

export const addAsset = (id: string, asset: AssetInput) =>
  invoke<ProjectSnapshot>('project_add_asset', { id, asset })

export const removeAsset = (id: string, refId: string) =>
  invoke<ProjectSnapshot>('project_remove_asset', { id, refId })

export const linkTask = (
  id: string,
  sessionId: string,
  title: string,
  workItemId?: string,
  references: InputRef[] = [],
  capabilities: CapabilityRef[] = [],
) =>
  invoke<ProjectSnapshot>('project_link_task', {
    id,
    sessionId,
    title,
    workItemId: workItemId ?? null,
    references,
    capabilities,
  })

export const loadTaskContext = (sessionId: string) =>
  invoke<TaskContext | null>('project_task_context', { sessionId })

/** 会话 id：Pi 侧是单条常驻会话，工作台里绑定的「会话任务」就挂在这个 id 上。 */
export const PI_SESSION_ID = 'pi-workbench:default'

/**
 * 代码库索引的共享 UI 状态。
 *
 * `codebaseIndexing` 只是「前端是否正在等后端索引」；真正的进度来自
 * `codebaseStatus`（后端落库的结果）。两者都放到模块级 ref，
 * ChatView（触发）和 ComposerStatus（展示）读同一份，避免状态分裂。
 */
export const codebaseIndexing = ref(false)
export const codebaseStatus = ref<CodebaseIndexStatus | null>(null)

/** 触发一次代码库索引（异步；会等后端把工作目录喂给 codebase-memory-mcp 跑完）。 */
export async function indexProjectCodebase(id: string): Promise<CodebaseIndexStatus> {
  codebaseIndexing.value = true
  try {
    const status = await invoke<CodebaseIndexStatus>('project_index_codebase', { id })
    codebaseStatus.value = { ...status, status: status.error ? 'error' : 'indexed' }
    return codebaseStatus.value
  } catch (e) {
    const msg = String((e as { message?: string })?.message ?? e)
    codebaseStatus.value = {
      project_id: id,
      project_name: '',
      status: 'error',
      nodes: 0,
      edges: 0,
      indexed_at: 0,
      error: msg,
    }
    throw e
  } finally {
    codebaseIndexing.value = false
  }
}

/** 读取项目当前的代码库索引状态（不触发重建），用于刷新面板。 */
export async function refreshCodebaseStatus(id: string): Promise<CodebaseIndexStatus | null> {
  const status = await invoke<CodebaseIndexStatus>('project_index_status', { id }).catch(() => null)
  codebaseStatus.value = status
  return status
}

/**
 * 把「项目 + 本次会话引用」编成一段前缀喂给内核。
 *
 * 之所以拼在 prompt 前面而不是改内核提示词模板：Pi 的 RPC 只接受
 * `type: prompt` 的文本，结构化上下文走同一条通道最稳——它能被完整记录、
 * 也能被用户看到，不会出现「内核悄悄吃了上下文但没人知道」的情况。
 */
export async function taskContextPreamble(sessionId = PI_SESSION_ID): Promise<string> {
  const ctx = await loadTaskContext(sessionId).catch(() => null)
  if (!ctx) return ''
  const caps = (ctx.task.capabilities ?? ctx.config.capabilities ?? []).map(
    (c) => c.label || `${c.kind}:${c.id}`,
  )
  const refs = (ctx.task.references ?? []).map((r) => r.label).filter(Boolean)
  const lines = [
    `[项目] ${ctx.project.name}`,
    `[配置修订 #${ctx.config.number}]`,
    ctx.config.instruction.trim(),
  ]
  if (caps.length) lines.push(`[本次可用能力] ${caps.join('、')}`)
  if (refs.length) lines.push(`[本次引用] ${refs.join('、')}`)
  return lines.filter(Boolean).join('\n')
}

/** 把内核返回的领域错误码翻成人话，前端不再对外暴露 projects/* 这类内部标识。 */
export function describeProjectError(err: unknown, fallback = '操作失败') {
  const raw = String((err as { message?: string })?.message ?? err)
  const map: Array<[string, string]> = [
    ['projects/revision-conflict', '这份内容已经被改过，请刷新后重试'],
    ['projects/instruction-budget-exceeded', '项目指令超出 token 预算，请精简后再保存'],
    ['projects/reference-stale', '引用的计划或资产已变更，请重新选择'],
    ['projects/capability-not-bound', '该能力未绑定在项目配置里'],
    ['projects/template-not-found', '模板不存在'],
    ['projects/not-found', '项目或对象不存在'],
  ]
  for (const [code, text] of map) if (raw.includes(code)) return text
  return fallback
}
