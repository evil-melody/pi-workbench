import { t } from '@/i18n'
/**
 * 专家域前端封装 —— 草稿 / 校验 / 发布确认链路。
 *
 * 命令签名与 Rust 侧一致（camelCase 入参）：
 *   experts_list / expert_draft_load / expert_draft_save / expert_validate
 *   expert_request_confirmation / expert_confirm / expert_publish
 *
 * 发布必须走「申请挑战 → 用户点确认 → 换取 proof → 发布」四步，
 * 中间任何一步内容变了，后面的 proof 立即作废，绝不因为模型自称已确认就放行。
 */
import { invoke } from '@tauri-apps/api/core'

export interface ExpertExample {
  id: string
  title?: string
  prompt: string
}

export interface SkillRequirement {
  name: string
  skill_id?: string
}

export interface ExpertDefinition {
  name: string
  description: string
  role: string
  methodology: string
  boundaries: string
  deliverables: string
  tags: string[]
  examples: ExpertExample[]
  skill_requirements: SkillRequirement[]
  /** 允许工具集（内核工具名，从 tools_list 取）。空 = 不限制。 */
  allowed_tools: string[]
  /** 拒绝模式：bash 命令命中任一子串即拦截。 */
  denied_patterns: string[]
  /** 停止条件，发布时写进 persona。 */
  stop_condition: string
  /** 单轮最大迭代次数；null = 内核默认。 */
  max_iterations?: number | null
  /** 导入时对未映射工具的决策记录（追溯用）。 */
  tool_mapping?: ToolMappingEntry[]
}

export interface ToolMappingEntry {
  /** 外部定义里的原始工具名。 */
  from: string
  /** 映射到的内核工具名；缺省 = 主动忽略。 */
  to?: string | null
  decision: 'mapped' | 'ignored'
}

export interface ExpertLastRun {
  run_id: string
  status: string
  at: number
}

export interface DomainIssue {
  code: string
  path?: string
  message: string
}

export interface ExpertDraft {
  definition: ExpertDefinition
  revision: number
  digest: string
  updated_at: number
  /** 外层元信息：编辑时原样展示，保存后由后端带回，不会退化成「本地创建」。 */
  source?: 'local' | 'imported'
  imported_from?: string
}

export interface ExpertSummary {
  id: string
  name: string
  description: string
  role: string
  tags: string[]
  published: boolean
  draft_revision: number
  digest: string
  /** 允许工具数；0 = 不限制。 */
  tool_count: number
  last_run: ExpertLastRun | null
  /** local = 本应用创建；imported = 外部导入。 */
  source: 'local' | 'imported'
}

export interface ImportUnmappedField {
  field: string
  reason: string
}

export interface ImportToolIssue {
  name: string
  /** 能唯一落到内核清单的候选；null 表示需要用户自己选。 */
  suggestion: string | null
}

export interface ImportExpertPreview {
  id: string
  name: string
  role: string
  definition: ExpertDefinition
  source_path: string
  conflict: boolean
  unmapped_tools: ImportToolIssue[]
  unmapped_fields: ImportUnmappedField[]
  warnings: string[]
}

export interface ImportPreview {
  source: string
  plugin: string | null
  unmapped_fields: ImportUnmappedField[]
  experts: ImportExpertPreview[]
}

export interface ImportApplyItem {
  id: string
  definition: ExpertDefinition
  conflict: 'skip' | 'overwrite' | 'rename'
  source_path: string
}

export interface ImportApplyResult {
  id: string
  action: 'created' | 'overwritten' | 'skipped'
  source_path: string
}

export interface ExpertPublication {
  id: string
  name: string
  digest: string
  revision: number
  persona_path: string
  policy_path?: string | null
}

export interface ConfirmationRequest {
  confirmation_token: string
  expert_id: string
  action: string
  draft_revision: string
  definition_digest: string
  dependency_lock_digest: string
  expires_at: number
  nonce: string
}

export interface ConfirmationProof {
  token: string
}

export function emptyDefinition(): ExpertDefinition {
  return {
    name: '',
    description: '',
    role: '',
    methodology: '',
    boundaries: '',
    deliverables: '',
    tags: [],
    examples: [],
    skill_requirements: [],
    allowed_tools: [],
    denied_patterns: [],
    stop_condition: '',
    max_iterations: null,
    tool_mapping: [],
  }
}

/** 删除专家：清草稿 / 已发布 / persona 与指向它的项目策略，不动 journal。 */
export async function expertDelete(id: string, root?: string | null): Promise<void> {
  await invoke('expert_delete', { id, root: root ?? null })
}

/** 预览外部专家：目录（plugin.json）或单个角色 md。 */
export async function expertImportPreview(
  path: string,
  availableTools: string[],
): Promise<ImportPreview> {
  return invoke<ImportPreview>('expert_import_preview', {
    path,
    available_tools: availableTools,
  })
}

/** 落盘导入结果。后端整体校验 + 快照回滚，不会出现导入一半。 */
export async function expertImportApply(items: ImportApplyItem[]): Promise<ImportApplyResult[]> {
  return invoke<ImportApplyResult[]>('expert_import_apply', { items })
}

/**
 * 应用工具映射：键是外部工具名；null / 空串表示忽略。
 * 映射后去重，保持原有顺序；同时把决策写进 `tool_mapping` 供日后追溯。
 */
export function resolveImportedTools(
  definition: ExpertDefinition,
  mappings: Record<string, string | null>,
): ExpertDefinition {
  const tools: string[] = []
  const records = (definition.tool_mapping ?? []).filter((m) => !(m.from in mappings))
  const decided = new Set(records.map((m) => m.from))
  for (const name of definition.allowed_tools) {
    if (!(name in mappings)) {
      if (!tools.includes(name)) tools.push(name)
      continue
    }
    // 同一外部工具可能重复出现在允许集里：决策只记一条。
    if (decided.has(name)) continue
    decided.add(name)
    const mapped = mappings[name]
    if (!mapped) {
      records.push({ from: name, to: null, decision: 'ignored' })
      continue
    }
    records.push({ from: name, to: mapped, decision: 'mapped' })
    if (!tools.includes(mapped)) tools.push(mapped)
  }
  return { ...definition, allowed_tools: tools, tool_mapping: records }
}

export async function expertsList(): Promise<ExpertSummary[]> {
  return invoke<ExpertSummary[]>('experts_list')
}

export async function expertDraftLoad(id: string): Promise<ExpertDraft | null> {
  return invoke<ExpertDraft | null>('expert_draft_load', { id })
}

export async function expertDraftSave(
  id: string,
  definition: ExpertDefinition,
  expectedRevision?: number,
): Promise<ExpertDraft> {
  return invoke<ExpertDraft>('expert_draft_save', {
    id,
    definition,
    expected_revision: expectedRevision ?? null,
  })
}

export async function expertValidate(definition: ExpertDefinition): Promise<DomainIssue[]> {
  return invoke<DomainIssue[]>('expert_validate', { definition })
}

export async function expertRequestConfirmation(
  id: string,
  draftRevision: number,
  definitionDigest: string,
): Promise<ConfirmationRequest> {
  return invoke<ConfirmationRequest>('expert_request_confirmation', {
    id,
    draft_revision: draftRevision,
    definition_digest: definitionDigest,
  })
}

export async function expertConfirm(token: string): Promise<ConfirmationProof> {
  return invoke<ConfirmationProof>('expert_confirm', { token })
}

export async function expertPublish(
  id: string,
  proof: ConfirmationProof,
  root?: string | null,
): Promise<ExpertPublication> {
  return invoke<ExpertPublication>('expert_publish', {
    id,
    proof,
    root: root ?? null,
  })
}

function expertErrorTable(): Array<[string, string]> {
  return [
  ['experts/confirmation-required', t('还需要你确认一次发布授权')],
  ['experts/confirmation-stale', t('授权已过期或内容已变更，请重新确认')],
  ['experts/revision-conflict', t('这份草稿已被改过，请刷新后重试')],
  ['experts/invalid-definition', t('定义尚未通过校验，不能发布')],
  ['experts/draft-not-found', t('草稿不存在，请先保存再发布')],
  ['experts/draft-unreadable', t('草稿读取失败，可能被外部改坏了')],
  ['experts/import-not-found', t('没找到 plugin.json，请选 WorkBuddy 插件目录或角色 md')],
  ['experts/import-no-agents', t('插件清单里没有可导入的角色文件')],
  ['experts/import-unreadable', t('文件读取失败或格式无法解析')],
  ['experts/import-invalid-id', t('专家 id 只能包含小写字母、数字、- 和 _')],
  ['experts/import-duplicate-id', t('多个导入项生成了同一个 id，请改名')],
  ['experts/import-invalid', t('有字段超出长度上限，请先在外部文件里精简')],
  ['experts/import-write-failed', t('写入失败，已回滚到导入前状态')],
  ]
}

export function describeExpertError(err: unknown, fallback = t('操作失败')): string {
  const raw = String((err as { message?: string })?.message ?? err)
  for (const [code, text] of expertErrorTable()) {
    if (raw.includes(code)) return text
  }
  return fallback
}

/** token 预算条用：与后端同样按「ASCII 4 字符 1 token，非 ASCII 1 字符 1 token」估算。 */
export function estimateTokens(text: string): number {
  let tokens = 0
  for (const ch of text) tokens += ch.charCodeAt(0) > 127 ? 1 : 0.25
  return Math.ceil(tokens)
}

/** 把校验问题按字段 path 归组，编辑器里直接贴到对应输入框下面。 */
export function groupIssues(issues: DomainIssue[]): Record<string, DomainIssue[]> {
  const out: Record<string, DomainIssue[]> = {}
  for (const issue of issues) {
    const key = issue.path ?? issue.code
    ;(out[key] ||= []).push(issue)
  }
  return out
}

export function issuesFor(issues: DomainIssue[], path: string): DomainIssue[] {
  return issues.filter((i) => (i.path ?? '') === path)
}
