import { t } from '@/i18n'
/**
 * 相对时间格式化（运行记录列表用，对齐 WorkDSH 的「11小时前 / 2天前」样式）。
 * 纯函数：now 可注入，便于单测与未来测试时钟固定。
 */
export function timeAgo(ms: number | null | undefined, now: number = Date.now()): string {
  if (!ms || ms <= 0 || !Number.isFinite(ms)) return ''
  const diff = now - ms
  if (diff < 0) return t('刚刚') // 时钟偏差：宁可「刚刚」不倒退到未来
  const min = Math.floor(diff / 60_000)
  if (min < 1) return t('刚刚')
  if (min < 60) return t('{0}分钟前', [min])
  const h = Math.floor(min / 60)
  if (h < 24) return t('{0}小时前', [h])
  const d = Math.floor(h / 24)
  if (d < 30) return t('{0}天前', [d])
  const mo = Math.floor(d / 30)
  if (mo < 12) return t('{0}个月前', [mo])
  return t('{0}年前', [Math.floor(mo / 12)])
}

/**
 * 消息时刻的绝对时钟（dsh `MessageIconActions` 的时钟位三档）：
 * 同日 `HH:mm`、同年跨日 `M月D日`、跨年 `YYYY年`（时分补零两位）。
 * 纯函数：now 可注入，便于单测与固定时钟。ts 缺失/非法返回空串——
 * 没有数据源就不显时间（journal 回放的消息没有本地时刻）。
 */
export function fmtClock(ts: number | null | undefined, now: number = Date.now()): string {
  if (!ts || !Number.isFinite(ts)) return ''
  const d = new Date(ts)
  const n = new Date(now)
  const p2 = (v: number) => String(v).padStart(2, '0')
  if (d.getFullYear() !== n.getFullYear()) return t('{0}年', [d.getFullYear()])
  if (d.getMonth() !== n.getMonth() || d.getDate() !== n.getDate())
    return t('{0}月{1}日', [d.getMonth() + 1, d.getDate()])
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`
}
