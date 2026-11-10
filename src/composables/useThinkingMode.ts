import { t } from '@/i18n'
import { computed, ref } from 'vue'

/**
 * 思考档位是全局偏好，不是对话页私有状态：
 * 对话页头部与项目工作台头部共用一份，切页面不丢选择。
 *
 * 持久化只存内核需要的 level，展示文案按当前语言实时计算；
 * 旧版本存的是中文档位名，读到后迁移成 level，避免切语言后失效。
 */
type Level = 'low' | 'medium' | 'high'

const LEVELS: Level[] = ['low', 'medium', 'high']
const LEGACY: Record<string, Level> = { 快速: 'low', 标准: 'medium', 深度: 'high' } // i18n-ignore: legacy persisted values
const KEY = 'pi-workbench:thinking-mode'

function normalize(value: string | null | undefined): Level {
  if (value && LEVELS.includes(value as Level)) return value as Level
  if (value && LEGACY[value]) return LEGACY[value]
  return 'medium'
}

const level = ref<Level>(normalize(localStorage.getItem(KEY)))

/** 内核接口需要的 level 值（low / medium / high）。 */
export const thinkingLevel = computed(() => level.value)
/** 界面上展示的当前语言档位名。 */
export const modeLabel = computed(() =>
  t(level.value === 'low' ? t('快速') : level.value === 'high' ? t('深度') : t('标准')),
)

export function setThinkingMode(next: string) {
  const value = normalize(next)
  level.value = value
  localStorage.setItem(KEY, value)
}
