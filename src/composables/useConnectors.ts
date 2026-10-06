/**
 * 连接器域前端封装。
 *
 * 命令签名与 Rust 侧一致（camelCase 入参）：
 *   connectors_list / connectors_config / connectors_create / connectors_update
 *   connectors_remove / connectors_set_enabled
 *   connectors_selection / connectors_set_selection / connectors_apply_scope
 *
 * 三条不能牺牲的语义：
 *   1. 令牌（authorization_token）是只写字段：任何读接口都不回传，前端拿到空串即「未改动」；
 *   2. serverName 全局唯一，重名会直接被后端拒绝（它决定工具命名空间 mcp__<server>__<tool>）；
 *   3. 会话选择不是「记一下」，要显式 apply_scope 才会真的改写注入内核的白名单。
 */
import { invoke } from '@tauri-apps/api/core'

export type ConnectorTransport = 'stdio' | 'streamable-http'

export type ConnectorState = 'discovering' | 'ready' | 'offline' | 'disabled'

export interface ConnectorSummary {
  id: string
  title: string
  description: string
  server_name: string
  transport: ConnectorTransport
  enabled: boolean
  state: ConnectorState
  /** 已经加过 `mcp__<server>__` 前缀的全名。 */
  tool_names: string[]
  tool_count: number
  diagnostic?: string
}

/** 编辑表单读回的视图：令牌不在这里。 */
export interface ConnectorConfigView {
  id: string
  title: string
  description: string
  server_name: string
  transport: ConnectorTransport
  command?: string
  args?: string[]
  url?: string
  authorization_configured: boolean
}

/**
 * 表单入参：command / args / url / 凭据一律给成必填的「原始字符串」，
 * 空串等于「没填」，由后端决定要不要拒绝；这样表单双向绑定不会带上 undefined。
 */
export interface ConnectorInput {
  title: string
  description: string
  server_name: string
  transport: ConnectorTransport
  command: string
  args: string[]
  url: string
  /** 只写：非空 = 更新凭据；空串 = 保持原值不动。 */
  authorization_token: string
}

export function emptyInput(): ConnectorInput {
  return {
    title: '',
    description: '',
    server_name: '',
    transport: 'stdio',
    command: '',
    args: [],
    url: '',
    authorization_token: '',
  }
}

export const connectorsList = (): Promise<ConnectorSummary[]> => invoke<ConnectorSummary[]>('connectors_list')

export const connectorsConfig = (id: string): Promise<ConnectorConfigView> =>
  invoke<ConnectorConfigView>('connectors_config', { id })

export const connectorsCreate = (input: ConnectorInput): Promise<ConnectorSummary> =>
  invoke<ConnectorSummary>('connectors_create', { input })

export const connectorsUpdate = (id: string, input: ConnectorInput): Promise<ConnectorSummary> =>
  invoke<ConnectorSummary>('connectors_update', { id, input })

export const connectorsRemove = (id: string): Promise<void> => invoke('connectors_remove', { id })

export const connectorsSetEnabled = (id: string, enabled: boolean): Promise<ConnectorSummary> =>
  invoke<ConnectorSummary>('connectors_set_enabled', { id, enabled })

export const connectorsSelection = (sessionId: string): Promise<string[]> =>
  invoke<string[]>('connectors_selection', { sessionId })

export const connectorsSetSelection = (
  sessionId: string,
  connectorIds: string[],
): Promise<string[]> => invoke<string[]>('connectors_set_selection', { sessionId, connectorIds })

/** 把选择真正落到内核白名单：返回应用后的完整工具作用域。 */
export const connectorsApplyScope = (sessionId: string): Promise<string[]> =>
  invoke<string[]>('connectors_apply_scope', { sessionId })

const ERROR_TEXT: Array<[string, string]> = [
  ['connector/title-required', '连接器名称不能为空'],
  ['connector/title-too-long', '连接器名称过长（上限 80 字）'],
  ['connector/description-too-long', '描述过长（上限 240 字）'],
  ['connector/server-name-invalid', '服务标识只能包含字母、数字、- 和 _，且不能为空'],
  ['connector/server-name-conflict', '该服务标识已被占用，工具命名空间不能重名'],
  ['connector/command-required', 'stdio 传输必须填写启动命令'],
  ['connector/command-too-long', '启动命令过长'],
  ['connector/args-too-many', '启动参数过多（上限 64 个）'],
  ['connector/arg-too-long', '单个启动参数过长'],
  ['connector/url-required', 'streamable-http 传输必须填写 URL'],
  ['connector/url-invalid', 'URL 必须以 http:// 或 https:// 开头'],
  ['connector/not-found', '连接器不存在，可能已被删除'],
  ['connector/disabled', '该连接器已停用，无法选中'],
  ['connector/not-ready', '该连接器还没握手成功，暂时不能选中'],
  ['connector/selection-limit-exceeded', '单个会话最多选 32 个连接器'],
]

/** 与专家域同一口径：认得的错误码给固定文案，认不得的回退兜底，不把后端原文抛给界面。 */
export function describeConnectorError(err: unknown, fallback = '操作失败'): string {
  const raw = String((err as { message?: string })?.message ?? err)
  for (const [code, text] of ERROR_TEXT) {
    if (raw.includes(code)) return text
  }
  return fallback
}

/** 服务标识的长度与字符集校验，纯前端先把明显错误标出来，省一次往返。 */
export function validateServerName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return '不能为空'
  if (trimmed.length > 32) return '不能超过 32 个字符'
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return '只能包含字母、数字、- 和 _'
  // 纯 - / _ 净化后会被后端 trim 成空串，前端先拦下来，免一次必失败的请求。
  if (!/[A-Za-z0-9]/.test(trimmed)) return '至少要包含一个字母或数字'
  return null
}

export const STATE_TEXT: Record<ConnectorState, string> = {
  discovering: '握手中',
  ready: '已连接',
  offline: '连接异常',
  disabled: '已停用',
}

export const TRANSPORT_TEXT: Record<ConnectorTransport, string> = {
  stdio: 'stdio 子进程',
  'streamable-http': 'Streamable HTTP',
}
