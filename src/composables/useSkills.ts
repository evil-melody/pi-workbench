import { invoke } from '@tauri-apps/api/core'

export interface SkillEntry {
  /** 技能名（`/skill:<name>` 里的部分）。 */
  name: string
  description: string
  /** skill | prompt | extension */
  kind: string
  path: string
  /** disk：本仓库扫盘得到；kernel：Pi 的 get_commands 回报 */
  via: string
  /** user | project | package */
  scope: string
  /** local（本地路径导入）| url（远端链接下载）| kernel（内核自带） */
  origin: string
}

export interface SkillInstallResult {
  entry: SkillEntry
  /** Pi 在启动时枚举技能目录，新装技能需要重启内核才生效。 */
  needs_restart: boolean
}

export interface SkillUninstallResult {
  name: string
  removed_path: string
  /** 内核缓存的技能列表过期，同样需要重启。 */
  needs_restart: boolean
}

export const skillsInstall = (path: string, root?: string, projectScope = true) =>
  invoke<SkillInstallResult>('skills_install', {
    path,
    root: root ?? null,
    projectScope,
  })

/** 社区市场链路：下载远端 SKILL.md 直链并按同一套规则落盘。 */
export const skillsInstallFromUrl = (url: string, root?: string, projectScope = false) =>
  invoke<SkillInstallResult>('skills_install_from_url', {
    url,
    root: root ?? null,
    projectScope,
  })

/** 只删 `<技能目录>/<name>/SKILL.md` 这一种形态，用户手工放别处的技能会被拒绝。 */
export const skillsUninstall = (name: string, root?: string) =>
  invoke<SkillUninstallResult>('skills_uninstall', { name, root: root ?? null })
