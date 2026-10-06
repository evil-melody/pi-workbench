import { open, save } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'

/**
 * 会话导入 / 导出（迁移）。
 *
 * 设计边界：Pi 内核自管 `.pi/sessions/` 持久化，workbench 层的「会话」是前端
 * `usePi` 的 `messages` 数组。这里的迁移只负责把这份内存对话序列化成
 * **版本化 JSON 文件**，导出落盘 / 导入读回都走真实 Tauri 对话框 + 后端命令，
 * 不造空壳。后续若要和 Pi 的 session 文件互通，是在此之上的增强，不是本期范围。
 */

/**
 * 一条附件引用。序列化时只存「路径引用」——真实文件已在发送时落盘到
 * app_config_dir/attachments（见后端 `attachment_add`）。导入后 Pi 内核按路径读取。
 * 与 `usePi.PiAttachment` 同形，这里独立定义以保持本模块纯函数、可单测、零依赖。
 */
export interface ConvAttachment {
  id: string
  name: string
  kind: 'image' | 'file'
  path: string
}

export interface ConvMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  tool?: string
  /** 导出时附带的时间戳（毫秒），导入后用于排序/展示。 */
  at?: number
  /** 用户消息附带的图片/文件引用。 */
  attachments?: ConvAttachment[]
}

export interface ConversationFile {
  format: 'pi-workbench-conversation'
  version: 1
  exportedAt: string
  messages: ConvMessage[]
}

const FORMAT = 'pi-workbench-conversation' as const

/** 把内存消息序列化成版本化结构。纯函数，不依赖 Tauri，可单测。 */
export function serializeConversation(messages: ConvMessage[]): ConversationFile {
  return {
    format: FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    messages: messages.map((m, i) => ({
      id: m.id || `m${i}`,
      role: m.role,
      text: m.text,
      ...(m.tool ? { tool: m.tool } : {}),
      ...(typeof m.at === 'number' ? { at: m.at } : {}),
      ...(m.attachments?.length
        ? {
            attachments: m.attachments.map((a) => ({
              id: a.id,
              name: a.name,
              kind: a.kind,
              path: a.path,
            })),
          }
        : {}),
    })),
  }
}

/** 解析会话文件并做严格校验；任一字段非法都抛错，不让坏文件静默加载。纯函数，可单测。 */
export function deserializeConversation(raw: unknown): ConvMessage[] {
  if (!raw || typeof raw !== 'object') throw new Error('不是合法的会话文件')
  const f = raw as Partial<ConversationFile>
  if (f.format !== FORMAT) throw new Error('文件格式不匹配（非 pi-workbench 会话）')
  if (!Array.isArray(f.messages)) throw new Error('会话文件缺少 messages 数组')
  return f.messages.map((m, i) => {
    if (!m || typeof m.text !== 'string' || !['user', 'assistant', 'system'].includes(m.role)) {
      throw new Error(`第 ${i + 1} 条消息格式非法`)
    }
    const attachments = Array.isArray(m.attachments)
      ? m.attachments
          .map((a, j) => {
            if (
              a &&
              typeof a.id === 'string' &&
              typeof a.name === 'string' &&
              (a.kind === 'image' || a.kind === 'file') &&
              typeof a.path === 'string'
            ) {
              return { id: a.id, name: a.name, kind: a.kind, path: a.path }
            }
            throw new Error(`第 ${i + 1} 条消息的附件 ${j + 1} 字段非法`)
          })
          // 空数组不写进结果，保持与发送侧一致。
          .filter(Boolean)
      : undefined
    return {
      id: m.id || `m${i}`,
      role: m.role,
      text: m.text,
      tool: m.tool,
      at: m.at,
      ...(attachments && attachments.length ? { attachments } : {}),
    }
  })
}

/** 导出当前会话：序列化 → 保存对话框 → 后端落盘。返回去向（路径 / 剪贴板 / 取消）。 */
export async function exportConversation(
  messages: ConvMessage[],
  fallbackName = 'conversation',
): Promise<'clipboard' | 'cancelled' | string> {
  const data = JSON.stringify(serializeConversation(messages), null, 2)
  const inTauri = '__TAURI_INTERNALS__' in window
  if (!inTauri) {
    try {
      await navigator.clipboard.writeText(data)
      return 'clipboard'
    } catch {
      return 'cancelled'
    }
  }
  const path = await save({
    defaultPath: `${fallbackName}.json`,
    filters: [{ name: '会话', extensions: ['json'] }],
  })
  if (typeof path !== 'string') return 'cancelled'
  await invoke('conversation_export', { path, content: data })
  return path
}

/** 导入会话：打开对话框 → 后端读文件 → 反序列化校验。取消时抛 'cancelled'。 */
export async function importConversation(): Promise<ConvMessage[]> {
  if (!('__TAURI_INTERNALS__' in window)) throw new Error('浏览器模式不支持导入')
  const selected = await open({
    multiple: false,
    filters: [{ name: '会话', extensions: ['json'] }],
  })
  if (typeof selected !== 'string') throw new Error('cancelled')
  const raw = await invoke<string>('conversation_import', { path: selected })
  return deserializeConversation(JSON.parse(raw))
}
