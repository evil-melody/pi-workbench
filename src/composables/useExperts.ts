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
}

export interface ExpertSummary {
  id: string
  name: string
  description: string
  tags: string[]
  published: boolean
  draft_revision: number
  digest: string
}

export interface ExpertPublication {
  id: string
  name: string
  digest: string
  revision: number
  persona_path: string
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
  }
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
    expectedRevision: expectedRevision ?? null,
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
    draftRevision,
    definitionDigest,
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

const ERROR_TEXT: Array<[string, string]> = [
  ['experts/confirmation-required', '还需要你确认一次发布授权'],
  ['experts/confirmation-stale', '授权已过期或内容已变更，请重新确认'],
  ['experts/revision-conflict', '这份草稿已被改过，请刷新后重试'],
  ['experts/invalid-definition', '定义尚未通过校验，不能发布'],
  ['experts/draft-not-found', '草稿不存在，请先保存再发布'],
  ['experts/draft-unreadable', '草稿读取失败，可能被外部改坏了'],
]

export function describeExpertError(err: unknown, fallback = '操作失败'): string {
  const raw = String((err as { message?: string })?.message ?? err)
  for (const [code, text] of ERROR_TEXT) {
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
