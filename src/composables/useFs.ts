import { invoke } from '@tauri-apps/api/core'

export interface FileNode {
  name: string
  path: string
  is_dir: boolean
  children?: FileNode[] | null
}

/** root 是允许访问的根（活动项目目录），越界请求由后端拒绝。 */
export const fsReadDir = (path: string, root: string) =>
  invoke<FileNode[]>('fs_read_dir', { path, root })
export const fsReadFile = (path: string, root: string) =>
  invoke<string>('fs_read_file', { path, root })
export const fsWriteFile = (path: string, content: string, root: string) =>
  invoke<void>('fs_write_file', { path, content, root })
