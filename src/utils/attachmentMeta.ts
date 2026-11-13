import { t } from '@/i18n'
import { formatBytes } from '@/composables/useArtifacts'

/**
 * 附件卡片的展示元信息（待发送托盘与气泡共用，保证「发送前 / 回放后」一致）。
 */
export function attachmentExt(name: string): string {
  const at = name.lastIndexOf('.')
  return at > 0 ? name.slice(at + 1).toLowerCase() : ''
}

/** 类型标签：扩展名大写；无扩展名回落「文件」。 */
export function attachmentType(name: string): string {
  const ext = attachmentExt(name)
  return ext ? ext.toUpperCase() : t('文件')
}

/** 第二行：类型 · 大小（旧 journal 无 size 时按未知显示，不编数字）。 */
export function attachmentMeta(a: { name: string; size?: number }): string {
  const size = a.size == null ? t('大小未知') : formatBytes(a.size)
  return `${attachmentType(a.name)} · ${size}`
}

/** 文件卡图标：代码/文本类用 code，其余用 file。 */
export function attachmentIcon(name: string): string {
  return /^(ts|tsx|js|jsx|vue|json|md|css|html|py|rs|go|sh|yml|yaml|toml)$/.test(
    attachmentExt(name),
  )
    ? 'code'
    : 'file'
}
