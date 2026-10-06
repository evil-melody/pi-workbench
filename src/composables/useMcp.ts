import { invoke } from '@tauri-apps/api/core'

export const mcpConnect = (name: string, command: string, args: string[]) =>
  invoke<any>('mcp_connect', { name, command, args })
export const mcpList = () => invoke<any[]>('mcp_list')
export const mcpCall = (server: string, tool: string, argsJson: string) =>
  invoke<any>('mcp_call', { server, tool, arguments: argsJson })
export const mcpDisconnect = (name: string) => invoke('mcp_disconnect', { name })
