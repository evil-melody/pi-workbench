import { createI18n } from 'vue-i18n'
import enUS from './en-US'

/**
 * 国际化运行时（runtime-only）。
 *
 * 词条 key 就是中文原文，`en-US` 是「中文 → 英文」映射；中文不另存词条表，
 * 缺英文时直接回退到 key 本身。`@context` 只用于区分同字不同义，
 * 展示时由 `stripContext` 去掉，绝不把上下文后缀或 raw key 暴露给用户。
 */
export type Locale = 'zh-CN' | 'en-US'
export type LocalePreference = 'system' | Locale

const STORAGE_KEY = 'pi-workbench:lang'

/** 消息编译把 `@` 当链接语法、`|` 当复数分隔符，词条值必须先转义。 */
function escapeMessage(text: string): string {
  return text.replace(/@/g, "{'@'}").replace(/\|/g, "{'|'}")
}

const enMessages: Record<string, string> = Object.fromEntries(
  Object.entries(enUS).map(([key, value]) => [key, escapeMessage(value)]),
)

export function stripContext(key: string): string {
  const at = key.indexOf('@')
  return at > 0 ? key.slice(0, at) : key
}

function interpolate(template: string, params?: Record<string, unknown> | unknown[]): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (raw, name: string) => {
    if (Array.isArray(params)) {
      const value = params[Number(name)]
      return value === undefined ? raw : String(value)
    }
    const value = params[name]
    return value === undefined ? raw : String(value)
  })
}

export function normalizeLocale(input?: string | null): Locale | null {
  if (!input) return null
  const value = input.toLowerCase()
  if (value.startsWith('zh')) return 'zh-CN'
  if (value.startsWith('en')) return 'en-US'
  return null
}

export function systemLocale(): Locale {
  if (typeof navigator === 'undefined') return 'zh-CN'
  return normalizeLocale(navigator.language) ?? 'zh-CN'
}

export function resolvePreference(preference: LocalePreference): Locale {
  return preference === 'system' ? systemLocale() : preference
}

function cachedLocale(): Locale | null {
  try {
    return normalizeLocale(localStorage.getItem(STORAGE_KEY))
  } catch {
    return null
  }
}

export const i18n = createI18n({
  legacy: false,
  locale: cachedLocale() ?? systemLocale(),
  fallbackLocale: 'zh-CN',
  messages: { 'en-US': enMessages, 'zh-CN': {} },
  missingWarn: false,
  fallbackWarn: false,
})

export function currentLocale(): Locale {
  return (i18n.global.locale.value as Locale) ?? 'zh-CN'
}

function applyLocale(locale: Locale, persist: boolean): void {
  i18n.global.locale.value = locale
  if (typeof document !== 'undefined') document.documentElement.lang = locale
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, locale)
    } catch {
      // 隐私模式下 localStorage 可能不可写，界面仍按本次选择生效。
    }
  }
}

/** 首屏同步执行：缓存 → 系统语言 → zh-CN。 */
export function initLocale(): Locale {
  const locale = cachedLocale() ?? systemLocale()
  applyLocale(locale, false)
  return locale
}

export function setLocalePreference(language?: string | null): Locale {
  const preference: LocalePreference =
    language === 'zh-CN' || language === 'en-US' ? language : 'system'
  const locale = resolvePreference(preference)
  applyLocale(locale, true)
  return locale
}

/**
 * 统一取词入口。
 *
 * - 英文且已有译文：交给 vue-i18n（插值 / 转义由它处理）。
 * - 其余情况（中文、英文缺译）：直接按源文格式化，保证插值仍然生效。
 */
export function t(key: string, params?: Record<string, unknown> | unknown[]): string {
  const locale = currentLocale()
  const message = enMessages[key]
  if (locale === 'en-US' && message) {
    return i18n.global.t(key, params as Record<string, unknown>)
  }
  return interpolate(stripContext(key), params)
}

/** 供覆盖率脚本与调试使用：当前英文词典。 */
export function englishMessages(): Record<string, string> {
  return { ...enUS }
}

export default i18n
