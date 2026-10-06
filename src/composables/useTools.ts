import { invoke } from '@tauri-apps/api/core'

/** 对内核可见的工具白名单（`<agent-dir>/settings.json` 的 defaultTools）。 */
export interface ToolSet {
  active: string[]
  /** 可选工具全集（后端能力清单给出），前端不写死。 */
  catalog: string[]
  settings_path: string
}

export const toolsList = () => invoke<ToolSet>('tools_list')

export const toolsActivate = (tools: string[], enable: boolean) =>
  invoke<ToolSet>('tools_activate', { tools, enable })
