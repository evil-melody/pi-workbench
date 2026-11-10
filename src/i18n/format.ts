import { currentLocale } from './index'

/** 日期时间统一走 Intl，跟随当前界面语言；时区固定为设备本地时区。 */
export function formatDateTime(
  value: string | number | Date,
  options: Intl.DateTimeFormatOptions = {},
): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return new Intl.DateTimeFormat(currentLocale(), options).format(date)
}

export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  return new Intl.NumberFormat(currentLocale(), options).format(value)
}

export function resolvedTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}
