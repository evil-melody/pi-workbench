/**
 * 相对时间格式化（运行记录列表用，对齐 WorkDSH 的「11小时前 / 2天前」样式）。
 * 纯函数：now 可注入，便于单测与未来测试时钟固定。
 */
export function timeAgo(ms: number | null | undefined, now: number = Date.now()): string {
  if (!ms || ms <= 0 || !Number.isFinite(ms)) return ''
  const diff = now - ms
  if (diff < 0) return '刚刚' // 时钟偏差：宁可「刚刚」不倒退到未来
  const min = Math.floor(diff / 60_000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min}分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}天前`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}个月前`
  return `${Math.floor(mo / 12)}年前`
}
