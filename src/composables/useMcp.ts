import { invoke } from '@tauri-apps/api/core'
import { listOf } from '@/utils/ipc'

// AUDIT-024：mcpConnect/mcpCall/mcpDisconnect 删除——ConnectorPanel 只用 mcpList，
// 这三个导出与底层 IPC 层重复造轮子且零调用。

export const mcpList = () => listOf(invoke<any[]>('mcp_list'))
