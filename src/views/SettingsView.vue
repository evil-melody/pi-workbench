<script setup lang="ts">
import { t } from '@/i18n'
import { computed, onMounted, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { open as openFile } from '@tauri-apps/plugin-dialog'
import { useRouter } from 'vue-router'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppSelect, { type SelectOption } from '@/components/ui/AppSelect.vue'
import AppCheckbox from '@/components/ui/AppCheckbox.vue'
import { describeIpcError } from '@/composables/useRuntime'
import { useBackground, type CloseAction } from '@/composables/useBackground'
import { onTablistKeydown } from '@/composables/useTablist'
import { setLocalePreference } from '@/i18n'
import {
  currentFontScale,
  currentTheme,
  setFontScale,
  setTheme,
  watchSystemTheme,
  type FontScale,
  type Theme,
} from '@/theme'
import { APP_NAME, APP_VERSION, PI_VERSION } from '@/version'

/**
 * 分区严格对齐 WorkBuddy 设置页三组侧栏；截图里的 15 项全量补齐，
 * 我方原有「桌面与启动 / 工具激活 / 关于」并入对应分组，不丢功能。
 * 无账户体系的两项（个人主页 / 套餐与积分）给本机说明，不伪造云端功能。
 */
type Tab =
  | 'general'
  | 'profile'
  | 'billing'
  | 'appearance'
  | 'shortcuts'
  | 'about'
  | 'personalize'
  | 'memory'
  | 'agent'
  | 'model'
  | 'assistant'
  | 'device'
  | 'flow'
  | 'desktop'
  | 'tools'
  | 'dataImport'
  | 'dataManage'
  | 'permissions'

interface SettingsNavItem {
  id: Tab
  label: string
  icon: string
}

interface SettingsNavGroup {
  label: string
  items: SettingsNavItem[]
}

const navGroups = computed<SettingsNavGroup[]>(() => [
  {
    label: t('设置'),
    items: [
      { id: 'general', label: t('通用'), icon: 'settings' },
      { id: 'profile', label: t('个人主页'), icon: 'user' },
      { id: 'billing', label: t('套餐与积分'), icon: 'chart' },
      { id: 'appearance', label: t('外观'), icon: 'sun' },
      { id: 'shortcuts', label: t('快捷键'), icon: 'list' },
      { id: 'about', label: t('关于'), icon: 'info' },
    ],
  },
  {
    label: t('功能'),
    items: [
      { id: 'personalize', label: t('个性化'), icon: 'sparkles' },
      { id: 'memory', label: t('记忆与进化'), icon: 'book' },
      { id: 'agent', label: t('智能体'), icon: 'users' },
      { id: 'model', label: t('模型'), icon: 'cpu' },
      { id: 'assistant', label: t('助理'), icon: 'chat' },
      { id: 'device', label: t('设备连接'), icon: 'plug' },
      { id: 'flow', label: t('对话流'), icon: 'branch' },
      { id: 'desktop', label: t('桌面与启动'), icon: 'monitor' },
      { id: 'tools', label: t('工具激活'), icon: 'tool' },
    ],
  },
  {
    label: t('数据与安全'),
    items: [
      { id: 'dataImport', label: t('数据导入'), icon: 'upload' },
      { id: 'dataManage', label: t('数据管理'), icon: 'folder' },
      { id: 'permissions', label: t('高级权限'), icon: 'lock' },
    ],
  },
])

const allNavItems = computed(() => navGroups.value.flatMap((g) => g.items))
const currentTitle = computed(() => allNavItems.value.find((i) => i.id === tab.value)?.label ?? '')

/** 顶部搜索：命中标题或说明的分区收进侧栏；无命中给空态。空组不渲染标题。 */
const searchQuery = ref('')
const filteredGroups = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return navGroups.value
  return navGroups.value
    .map((g) => ({
      ...g,
      items: g.items.filter(
        (item) =>
          item.label.toLowerCase().includes(q) ||
          (navDescriptions[item.id] ?? '').toLowerCase().includes(q) ||
          g.label.toLowerCase().includes(q),
      ),
    }))
    .filter((g) => g.items.length)
})
const filteredNav = computed(() => filteredGroups.value.flatMap((g) => g.items))
// 当前分区被搜索滤掉时跳到首个命中项，右侧内容永远对得上侧栏选中态。
watch(filteredNav, (list) => {
  if (list.length && !list.some((item) => item.id === tab.value)) tab.value = list[0].id
})

/* 搜索关键词是检索数据，非 UI 文案：中英双份词元参与匹配。 */
const navDescriptions: Partial<Record<Tab, string>> = {
  general: '界面语言 归档 下载源 language archive download', // i18n-ignore
  profile: '个人 主页 本机 账户 profile account', // i18n-ignore
  billing: '套餐 积分 计费 配额 billing plan quota', // i18n-ignore
  appearance: '主题 字号 浅色 深色 theme font size appearance', // i18n-ignore
  shortcuts: '键盘 命令面板 ⌘K keyboard', // i18n-ignore
  about: '版本 内核 桌面壳 version', // i18n-ignore
  personalize: '个性化 偏好 主题 字号 personal preference', // i18n-ignore
  memory: '记忆 进化 归档 云端 本地 memory evolution archive', // i18n-ignore
  agent: '智能体 团队 专家 agent team expert', // i18n-ignore
  model: 'API 密钥 服务商 base url 内核 pi model', // i18n-ignore
  assistant: '助理 角色 召唤 role assistant', // i18n-ignore
  device: '设备 连接 连接器 关窗 登录项 device connector login', // i18n-ignore
  flow: '对话流 工具 白名单 tool allowlist flow', // i18n-ignore
  desktop: '关窗 后台 驻留 登录项 启动 close window launch at login', // i18n-ignore
  tools: '白名单 工具 tool allowlist', // i18n-ignore
  dataImport: '数据 导入 专家 技能 连接器 import', // i18n-ignore
  dataManage: '数据 管理 资料库 归档 下载源 library archive', // i18n-ignore
  permissions: '完全访问 风险 审批 full access risky approval', // i18n-ignore
}

type LanguageChoice = 'system' | 'zh-CN' | 'en-US'
type ThemeChoice = 'system' | Theme

interface ModelConfig {
  id: string
  name: string
  provider: string
  base_url: string
  model: string
  api_key: string
  temperature: number
  max_tokens: number
  enabled: boolean
}

interface AppSettings {
  models: ModelConfig[]
  default_model_id?: string
  theme?: string
  language?: string | null
  /** Pi 可执行文件绝对路径；null/空 = 后端自动探测。 */
  pi_bin?: string | null
  /** 会话产物自动归档；null/缺省 = 开启。 */
  auto_archive_artifacts?: boolean | null
  /** 本地模型下载源；null/缺省 = 默认镜像。 */
  download_source?: string | null
  /** 完全访问权限：true = 风险命令免审批；缺省按 false。 */
  full_access?: boolean
}

interface DownloadSourceInfo {
  endpoint: string
  mode: 'mirror' | 'official' | 'custom'
  origin: 'settings' | 'env' | 'default'
  mirror: string
  official: string
  active_tasks: number
}

const tab = ref<Tab>('general')
const router = useRouter()

/** macOS 显示 ⌘，其它平台显示 Ctrl（与 App.vue 的平台判定同一口径）。 */
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/i.test(navigator.platform)

/** 快捷键只列真实存在的消费点（CommandPalette / composer 回车 / Esc），不臆造。 */
const shortcutRows = computed<{ keys: string; label: string }[]>(() => [
  { keys: IS_MAC ? '⌘K' : 'Ctrl+K', label: t('打开命令面板') },
  { keys: t('Enter'), label: t('发送消息（输入框）') },
  { keys: t('Shift+Enter'), label: t('换行') },
  { keys: t('Esc'), label: t('关闭菜单、弹窗与命令面板') },
])

/** 无真实设置项的入口一律说明现状 + 指向已有能力，不造空开关。 */
interface SettingsJumpAction {
  label: string
  icon: string
  to?: string
  tab?: Tab
}

interface SettingsJumpInfo {
  desc: string
  actions: SettingsJumpAction[]
}

const jumpInfo: Partial<Record<Tab, SettingsJumpInfo>> = {
  profile: {
    desc: t('当前桌面版不接账户体系；本机工作区就是个人主页，数据只保存在这台设备上。'),
    actions: [{ label: t('打开资料库'), icon: 'book', to: '/library' }],
  },
  billing: {
    desc: t('当前版本没有套餐与积分：所有能力在本地运行，不设云端配额，也不会因用量受限。'),
    actions: [],
  },
  agent: {
    desc: t('智能体团队由专家、技能与连接器装配而成；运行前先在能力中心完成配置。'),
    actions: [
      { label: t('打开智能体团队'), icon: 'users', to: '/capabilities?tab=team' },
      { label: t('专家市场'), icon: 'sparkles', to: '/capabilities?tab=expert' },
    ],
  },
  assistant: {
    desc: t('助理就是对话中的召唤形态：用输入框「+」选择角色、专家与运行模式，选择只保留一份状态。'),
    actions: [{ label: t('开始对话'), icon: 'chat', to: '/chat' }],
  },
  dataImport: {
    desc: t('从 WorkBuddy 插件目录或本机文件导入外部能力；导入前可逐个预览并决定工具映射。'),
    actions: [
      { label: t('导入专家'), icon: 'sparkles', to: '/capabilities?tab=expert' },
      { label: t('安装技能'), icon: 'puzzle', to: '/capabilities?tab=skill' },
      { label: t('导入连接器'), icon: 'plug', to: '/capabilities?tab=connector' },
    ],
  },
  dataManage: {
    desc: t('会话产物按设置自动归档进资料库；模型下载源与归档开关在「通用」分区。'),
    actions: [
      { label: t('打开资料库'), icon: 'book', to: '/library' },
      { label: t('前往通用设置'), icon: 'settings', tab: 'general' },
    ],
  },
}

function runJump(action: SettingsJumpAction) {
  if (action.tab) tab.value = action.tab
  else if (action.to) router.push(action.to)
}

const activeJump = computed(() => jumpInfo[tab.value])

/** 设置改为弹窗后，关闭即回到进入前的页面；直接打开该路由时退回会话页。 */
function closeSettings() {
  if (window.history.length > 1) router.back()
  else router.push('/chat')
}
const saving = ref(false)
const testing = ref<string | null>(null)
const message = ref('')
const error = ref('')
const loading = ref(true)
const toolError = ref('')

/* ── 语言 ────────────────────────────────────────────────── */
const language = ref<LanguageChoice>('system')
/** 会话产物自动归档：默认开启，关闭后后端也不再接收归档任务。 */
const autoArchive = ref(true)
const rawSettings = ref<AppSettings | null>(null)

/* ── 外观（1:1 WorkBuddy 设置「外观」：浅色/深色/跟随系统）────────── */
/** theme.ts 的 localStorage 选择是生效源；'system' = 清掉显式选择跟系统走。 */
const themeChoice = ref<ThemeChoice>('system')

const themeOptions = computed<SelectOption[]>(() => [
  { value: 'system', label: t('跟随系统'), hint: t('按系统深浅色自动切换') },
  { value: 'light', label: t('浅色') },
  { value: 'dark', label: t('深色') },
])

function readThemeChoice(): ThemeChoice {
  const saved = localStorage.getItem('pi-workbench:theme')
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

function applyThemeChoice(value: string) {
  const choice = value === 'light' || value === 'dark' ? value : 'system'
  themeChoice.value = choice
  if (choice === 'system') {
    localStorage.removeItem('pi-workbench:theme')
    const sys = currentTheme()
    document.documentElement.dataset.theme = sys
    // 窗口底色也要同步：theme.ts 的 syncWindowTheme 是私有函数，这里直接补一次 IPC。
    invoke('window_set_theme', { theme: sys }).catch(() => undefined)
  } else {
    setTheme(choice)
  }
}

/* ── 字号（1:1 WorkBuddy 设置「字号」：全站走同一阶梯，改因子等比缩放）── */
const fontScale = ref<FontScale>('md')

const fontScaleOptions = computed<SelectOption[]>(() => [
  { value: 'sm', label: t('小'), hint: t('约 90% 缩放') },
  { value: 'md', label: t('标准'), hint: t('默认大小') },
  { value: 'lg', label: t('大'), hint: t('约 110% 缩放') },
  { value: 'xl', label: t('特大'), hint: t('约 120% 缩放') },
])

function applyFontScaleChoice(value: string) {
  const choice: FontScale = value === 'sm' || value === 'lg' || value === 'xl' ? value : 'md'
  fontScale.value = choice
  setFontScale(choice)
}

/* ── 权限（1:1 WorkBuddy 设置「权限」：默认 / 完全访问）────────────── */
/** 消费点在 agent-tool-gate：开启后交互路径的风险命令免审批；灾难黑名单与受保护路径仍拦。 */
const fullAccess = ref(false)
const fullAccessSaving = ref(false)

async function changeFullAccess(value: boolean) {
  fullAccessSaving.value = true
  const prev = fullAccess.value
  fullAccess.value = value
  try {
    const settings = { ...fullSettings(), full_access: value }
    await invoke('settings_save', { settings })
    rawSettings.value = settings
  } catch (e) {
    fullAccess.value = prev
    error.value = describeIpcError(e, t('保存权限设置'))
  } finally {
    fullAccessSaving.value = false
  }
}

/* ── 本地模型下载源 ──────────────────────────────────────── */
const downloadMode = ref<'mirror' | 'official' | 'custom'>('mirror')
const downloadCustom = ref('')
const downloadSource = ref<DownloadSourceInfo | null>(null)
const downloadNote = ref('')

const downloadSourceOptions = computed<SelectOption[]>(() => [
  { value: 'mirror', label: t('国内镜像（推荐）'), hint: 'hf-mirror.com' },
  { value: 'official', label: t('直连官方'), hint: 'huggingface.co' },
  { value: 'custom', label: t('自定义'), hint: t('填写兼容 HuggingFace 的镜像地址') },
])

const downloadSourceLabel = computed(() => {
  const s = downloadSource.value
  if (!s) return '—'
  const name =
    s.mode === 'mirror' ? t('国内镜像') : s.mode === 'official' ? t('直连官方') : t('自定义')
  return `${s.endpoint}（${name}）`
})

async function refreshDownloadSource() {
  try {
    const info = await invoke<DownloadSourceInfo>('local_download_source')
    downloadSource.value = info
    downloadMode.value = info.mode
    if (info.mode === 'custom') downloadCustom.value = info.endpoint
    return info
  } catch {
    return null
  }
}

/**
 * 下载源是任务级快照：这里只改「新任务」的源，正在跑的任务继续用启动时的地址。
 * 因此在途任务数 > 0 时把话说清楚，避免用户以为已经换源。
 */
async function persistDownloadSource(endpoint: string) {
  downloadNote.value = ''
  try {
    const settings = { ...fullSettings(), download_source: endpoint }
    await invoke('settings_save', { settings })
    rawSettings.value = settings
    const info = await refreshDownloadSource()
    if (info && info.active_tasks > 0) {
      downloadNote.value = t(
        '有 {n} 个任务正在用原地址继续下载，新任务才使用 {source}。如需立即换源，请到本地模型页取消后重新下载。',
        { n: info.active_tasks, source: endpoint },
      )
    }
  } catch (e) {
    error.value = describeIpcError(e, t('保存设置'))
  }
}

function changeDownloadSource(value: string) {
  const mode = value === 'official' ? 'official' : value === 'custom' ? 'custom' : 'mirror'
  downloadMode.value = mode
  if (mode === 'custom') {
    if (!downloadCustom.value) downloadCustom.value = downloadSource.value?.endpoint ?? ''
    return
  }
  const endpoint =
    mode === 'mirror'
      ? (downloadSource.value?.mirror ?? 'https://hf-mirror.com')
      : (downloadSource.value?.official ?? 'https://huggingface.co')
  void persistDownloadSource(endpoint)
}

function applyCustomSource() {
  const url = downloadCustom.value.trim()
  if (!url) {
    error.value = t('下载源地址不能为空')
    return
  }
  void persistDownloadSource(url)
}

const languageOptions = computed<SelectOption[]>(() => [
  { value: 'system', label: t('跟随系统'), hint: t('按系统语言自动选择中文或英文') },
  { value: 'zh-CN', label: t('简体中文') },
  { value: 'en-US', label: 'English' },
])

/** settings_save 是整包覆盖：先把读到的原始设置存下来，保存时整体回写。 */
function fullSettings(): AppSettings {
  return {
    ...(rawSettings.value ?? { models: [] }),
    models: models.value,
    default_model_id: defaultModelId.value,
    pi_bin: piBin.value.trim() || null,
    language: language.value === 'system' ? null : language.value,
    auto_archive_artifacts: autoArchive.value,
    full_access: fullAccess.value,
  }
}

/** 自动归档是独立开关，改完立即落盘；失败时回滚勾选状态。 */
async function changeAutoArchive(value: boolean) {
  autoArchive.value = value
  try {
    const settings = fullSettings()
    await invoke('settings_save', { settings })
    rawSettings.value = settings
  } catch (e) {
    autoArchive.value = !value
    error.value = describeIpcError(e, t('保存设置'))
  }
}

async function changeLanguage(value: string) {
  language.value = value === 'zh-CN' || value === 'en-US' ? value : 'system'
  setLocalePreference(language.value === 'system' ? null : language.value)
  applyInputs()
  try {
    const settings = fullSettings()
    await invoke('settings_save', { settings })
    rawSettings.value = settings
    await invoke('tray_relocalize').catch(() => undefined)
  } catch (e) {
    error.value = describeIpcError(e, t('保存设置'))
  }
}

/* ── 后台与启动（关窗行为 / 登录项）────────────────────────── */
const { info: bgInfo, refresh: refreshBackground, setCloseAction, setAutostart } =
  useBackground()
const bgError = ref('')

const closeActionOptions = computed<SelectOption[]>(() => [
  { value: 'ask', label: t('每次询问'), hint: t('首次关闭后记住选择') },
  { value: 'background', label: t('驻留后台继续执行'), hint: t('关窗只隐藏，定时任务照常调度') },
  { value: 'quit', label: t('直接退出'), hint: t('停止调度并清理预授权策略') },
])

async function loadBackground() {
  bgError.value = ''
  try {
    await refreshBackground()
  } catch (e) {
    bgError.value = describeIpcError(e, t('读取后台设置'))
  }
}

async function changeCloseAction(value: string) {
  bgError.value = ''
  try {
    await setCloseAction(value as CloseAction)
  } catch (e) {
    bgError.value = describeIpcError(e, t('更新关窗行为'))
    await loadBackground()
  }
}

async function toggleAutostart(value: boolean) {
  bgError.value = ''
  try {
    await setAutostart(value)
  } catch (e) {
    bgError.value = describeIpcError(e, t('更新登录项'))
    await loadBackground()
  }
}

const providers: SelectOption[] = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'azure', label: 'Azure OpenAI' },
  { value: 'local', label: 'Local / vLLM' },
  { value: 'custom', label: t('自定义') },
]

const models = ref<ModelConfig[]>([])
const defaultModelId = ref('')
const expandedIds = ref<Set<string>>(new Set())
const showKey = ref('')
const inputMap = ref<Record<string, { temperature: string; max_tokens: string }>>({})

const hasModels = computed(() => models.value.length > 0)

function syncInputMap(id: string, m?: ModelConfig) {
  if (!m) {
    delete inputMap.value[id]
    return
  }
  inputMap.value[id] = {
    temperature: String(m.temperature),
    max_tokens: String(m.max_tokens),
  }
}

function applyInputs() {
  for (const m of models.value) {
    const inputs = inputMap.value[m.id]
    if (!inputs) continue
    const t = parseFloat(inputs.temperature)
    if (!Number.isNaN(t)) m.temperature = Math.min(Math.max(t, 0), 2)
    const n = parseInt(inputs.max_tokens, 10)
    if (!Number.isNaN(n)) m.max_tokens = Math.max(n, 1)
  }
}

function providerLabel(p: string) {
  return providers.find((x) => x.value === p)?.label ?? p
}

function newId() {
  return crypto.randomUUID()
}

function defaultModel(): ModelConfig {
  return {
    id: newId(),
    name: t('新模型'),
    provider: 'openai',
    base_url: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    api_key: '',
    temperature: 0.6,
    max_tokens: 4096,
    enabled: true,
  }
}

/**
 * Temperature / Max Tokens 用字符串受控（允许中途输入 "0." 这种非法中间态），
 * 因此需要一张 id → 字符串的旁路表。模板里会直接读 `inputMap[m.id]`，
 * 一旦缺条目就是渲染期抛错、整页失活，所以这里保证不变量：**models 里的每个 id 必有条目**。
 */
watch(
  models,
  (list) => {
    for (const m of list) if (!inputMap.value[m.id]) syncInputMap(m.id, m)
  },
  { immediate: true },
)

// Pi 内核可执行文件
const piBin = ref('')
const piDoctor = ref<{ found: boolean; path?: string; error?: string } | null>(null)

/**
 * 桌面 App 的 PATH 里通常没有 pi（macOS GUI 进程只有 /usr/bin 等），
 * 后端已在常见目录自动探测；探测不到时在这里手动指定绝对路径。
 */
async function detectPi() {
  piDoctor.value = null
  try {
    const r = await invoke<{ found: boolean; path?: string; error?: string }>('pi_doctor')
    piDoctor.value = r
    if (r.found && r.path && !piBin.value.trim()) piBin.value = r.path
  } catch (e) {
    piDoctor.value = { found: false, error: describeIpcError(e, t('内核自检')) }
  }
}

async function pickPiBin() {
  try {
    const picked = await openFile({ multiple: false, title: t('选择 pi 可执行文件') })
    const p = Array.isArray(picked) ? picked[0] : picked
    if (p) piBin.value = p
  } catch {
    // 取消选择：保持原值
  }
}

async function load() {
  try {
    const s = await invoke<AppSettings>('settings_load')
    rawSettings.value = s
    language.value = s.language === 'zh-CN' || s.language === 'en-US' ? s.language : 'system'
    models.value = s.models?.length ? s.models : [defaultModel()]
    defaultModelId.value = s.default_model_id ?? models.value[0]?.id ?? ''
    piBin.value = s.pi_bin ?? ''
    autoArchive.value = s.auto_archive_artifacts !== false
    fullAccess.value = s.full_access === true
    themeChoice.value = readThemeChoice()
    fontScale.value = currentFontScale()
    expandedIds.value = new Set([defaultModelId.value])
    inputMap.value = {}
    for (const m of models.value) syncInputMap(m.id, m)
    message.value = ''
    error.value = ''
  } catch (e) {
    error.value = describeIpcError(e, t('读取设置'))
  } finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  message.value = ''
  error.value = ''
  applyInputs()
  try {
    const settings = fullSettings()
    await invoke('settings_save', { settings })
    rawSettings.value = settings
    // 模型是启动参数注入内核的，改完必须重启才生效；内核没在跑时后端会跳过。
    const restarted = await invoke<boolean>('pi_restart').catch(() => false)
    // 路径可能刚改过：重启后立刻自检，让用户当场知道内核现在能不能起来。
    await detectPi()
    message.value = restarted ? t('已保存，内核已重启生效') : t('已保存')
  } catch (e) {
    error.value = describeIpcError(e, t('保存设置'))
  } finally {
    saving.value = false
  }
}

async function testModel(m: ModelConfig) {
  testing.value = m.id
  message.value = ''
  error.value = ''
  applyInputs()
  try {
    const result = await invoke<string>('settings_test_model', { config: m })
    message.value = `${m.name}: ${result}`
  } catch (e) {
    error.value = `${m.name}: ${describeIpcError(e, t('连通性测试'))}`
  } finally {
    testing.value = null
  }
}

function addModel() {
  const m = defaultModel()
  m.name = t('模型 {0}', [models.value.length + 1])
  models.value.push(m)
  syncInputMap(m.id, m)
  expandedIds.value = new Set([...expandedIds.value, m.id])
}

function removeModel(id: string) {
  models.value = models.value.filter((m) => m.id !== id)
  syncInputMap(id)
  expandedIds.value.delete(id)
  expandedIds.value = new Set(expandedIds.value)
  if (defaultModelId.value === id) {
    defaultModelId.value = models.value.find((m) => m.enabled)?.id ?? models.value[0]?.id ?? ''
  }
  if (!models.value.length) {
    addModel()
    defaultModelId.value = models.value[0].id
  }
}

function setDefault(id: string) {
  defaultModelId.value = id
  const m = models.value.find((x) => x.id === id)
  if (m) m.enabled = true
}

function toggleExpand(id: string) {
  const next = new Set(expandedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expandedIds.value = next
}

function onEnabledChange(id: string, enabled: boolean) {
  const m = models.value.find((x) => x.id === id)
  if (!m) return
  m.enabled = enabled
  if (defaultModelId.value === id && !enabled) {
    defaultModelId.value = models.value.find((x) => x.enabled && x.id !== id)?.id ?? ''
  }
  if (enabled && !defaultModelId.value) {
    defaultModelId.value = id
  }
}

// Tools tab
const tools = ref<{ name: string; description: string; active: boolean }[]>([])
const toolSet = ref<{ active: string[] }>({ active: [] })

async function loadTools() {
  // 浏览器预览下 invoke 会 reject；不接住就是未处理的 Promise，页面直接抛异常。
  try {
    const set = await invoke<{ active: string[]; catalog: string[] }>('tools_list')
    toolSet.value = set
    tools.value = set.catalog.map((name) => ({
      name,
      description: toolDescription(name),
      active: set.active.includes(name),
    }))
  } catch (e) {
    tools.value = []
    toolError.value = describeIpcError(e, t('读取工具列表'))
  }
}

function toolDescription(name: string) {
  const map: Record<string, string> = {
    read: t('读取项目文件内容'),
    bash: t('执行 Shell 命令'),
    edit: t('编辑项目文件'),
    write: t('写入新文件'),
    search: t('在项目中搜索'),
    browser: t('操作智能体浏览器'),
    python: t('执行 Python 代码'),
  }
  return map[name] ?? name
}

async function toggleTool(name: string, nextActive: boolean) {
  try {
    const set = await invoke<{ active: string[]; catalog: string[] }>('tools_activate', {
      tools: [name],
      enable: nextActive,
    })
    toolSet.value = set
    tools.value = tools.value.map((x) => ({ ...x, active: set.active.includes(x.name) }))
    toolError.value = ''
    // 白名单只在启动时读入，改完重启内核才生效；内核没在跑时后端会跳过。
    const restarted = await invoke<boolean>('pi_restart').catch(() => false)
    message.value = restarted ? t('工具白名单已更新，内核已重启生效') : t('工具白名单已更新')
  } catch (e) {
    toolError.value = describeIpcError(e, t('更新工具白名单'))
  }
}

onMounted(() => {
  load()
  loadTools()
  void loadBackground()
  void refreshDownloadSource()
  // 一进设置就自检：找不到 pi 时模型配得再对也跑不起来，这条要最先看见。
  void detectPi()
})
</script>

<template>
  <AppModal :open="true" :title="t('设置')" size="page" @close="closeSettings">
    <div class="settings-body">
      <aside class="settings-tabs">
        <!-- 1:1 WorkBuddy 设置页：侧栏顶部搜索框，按分区标题/说明过滤 -->
        <div class="settings-search">
          <AppIcon name="search" :size="14" />
          <input
            v-model="searchQuery"
            type="search"
            :placeholder="t('搜索设置')"
            :aria-label="t('搜索设置')"
          />
        </div>
        <div class="settings-nav" role="tablist" :aria-label="t('设置分区')" @keydown="onTablistKeydown">
          <template v-for="group in filteredGroups" :key="group.label">
            <p class="settings-nav-group">{{ group.label }}</p>
            <AppButton
              v-for="item in group.items"
              :key="item.id"
              variant="tab"
              role="tab"
              :aria-selected="tab === item.id"
              :tabindex="tab === item.id ? 0 : -1"
              :class="{ active: tab === item.id }"
              @click="tab = item.id"
            >
              <AppIcon :name="item.icon" :size="16" />
              <span>{{ item.label }}</span>
            </AppButton>
          </template>
          <p v-if="!filteredNav.length" class="settings-nav-empty">{{ t('没有匹配的分区') }}</p>
        </div>
      </aside>

      <main class="settings-main">
        <section v-if="tab === 'general'" class="settings-section">
          <h2>{{ currentTitle }}</h2>
          <p class="section-desc">{{ t('界面语言只影响 Pi Workbench 的界面与系统提示，不改变模型输出。切换语言不会重启内核。') }}</p>
          <label class="field full inline">
            <span>{{ t('界面语言') }}</span>
            <AppSelect
              :model-value="language"
              :options="languageOptions"
              width="220px"
              @update:model-value="changeLanguage"
            />
          </label>
          <label class="field full inline">
            <AppCheckbox
              :model-value="autoArchive"
              :label="t('会话结束后自动把产物归档进资料库')"
              @update:model-value="changeAutoArchive"
            />
          </label>
          <label class="field full inline">
            <span>{{ t('模型下载源') }}</span>
            <AppSelect
              :model-value="downloadMode"
              :options="downloadSourceOptions"
              width="220px"
              @update:model-value="changeDownloadSource"
            />
          </label>
          <label v-if="downloadMode === 'custom'" class="field full">
            <span>{{ t('自定义下载源（兼容 HuggingFace 的镜像地址）') }}</span>
            <div class="password-row">
              <AppInput v-model="downloadCustom" placeholder="https://hf-mirror.com" class="flex" />
              <AppButton type="button" variant="secondary" @click="applyCustomSource">
                {{ t('应用') }}
              </AppButton>
            </div>
          </label>
          <p class="bg-hint">
            {{ t('当前下载源：{source}。切换只影响新任务，正在下载的任务继续使用启动时的地址。', { source: downloadSourceLabel }) }}
          </p>
          <p v-if="downloadNote" class="form-message">{{ downloadNote }}</p>
          <p v-if="error" class="form-message err">{{ error }}</p>
        </section>

        <section v-else-if="tab === 'appearance' || tab === 'personalize'" class="settings-section">
          <h2>{{ currentTitle }}</h2>
          <p class="section-desc">{{ t('界面配色与字号立即生效并持久保存；「跟随系统」会随系统深浅色自动切换。') }}</p>
          <label class="field full inline">
            <span>{{ t('主题') }}</span>
            <AppSelect
              :model-value="themeChoice"
              :options="themeOptions"
              width="220px"
              @update:model-value="applyThemeChoice"
            />
          </label>
          <label class="field full inline">
            <span>{{ t('字号') }}</span>
            <AppSelect
              :model-value="fontScale"
              :options="fontScaleOptions"
              width="220px"
              @update:model-value="applyFontScaleChoice"
            />
          </label>
        </section>

        <section v-else-if="tab === 'permissions'" class="settings-section">
          <h2>{{ currentTitle }}</h2>
          <p class="section-desc">{{ t('Agent 执行风险操作（删除文件、提权、写项目外路径等）时的确认方式。') }}</p>
          <label class="field full inline">
            <AppCheckbox
              :model-value="fullAccess"
              :disabled="fullAccessSaving"
              :label="t('完全访问权限：风险操作不再逐条询问')"
              @update:model-value="changeFullAccess"
            />
          </label>
          <p class="bg-hint">
            {{ fullAccess
              ? t('已开启：风险命令直接执行。灾难命令（rm -rf / 强推远端 / curl 管道执行 / 写块设备）与受保护路径（/etc、~/.ssh、.env 等）仍然强制拦截。')
              : t('默认模式：风险命令需要逐条审批（90 秒无响应自动拒绝）。灾难命令与受保护路径始终拦截。') }}
          </p>
        </section>

        <section v-else-if="tab === 'model'" class="settings-section">
          <h2>{{ currentTitle }}</h2>
          <p class="section-desc">{{ t('支持配置多个模型，可切换默认模型。API Key 仅保存在本地配置文件中，不会回显到日志。') }}</p>

          <!-- 内核排在最前：找不到 pi 时点发送毫无反应，模型配得再对也跑不起来。 -->
          <div class="kernel-card">
            <div class="kernel-head">
              <AppIcon name="terminal" :size="14" />
              <strong>{{ t('Pi 内核') }}</strong>
              <span class="muted">{{ t('桌面 App 的 PATH 里常没有 pi，找不到时发送无响应') }}</span>
            </div>

            <label class="field full">
              <span>{{ t('pi 可执行文件（留空 = 自动探测）') }}</span>
              <div class="password-row">
                <AppInput v-model="piBin" placeholder="/Users/.../bin/pi" class="flex" />
                <AppButton type="button" variant="icon" class="eye-btn" :title="t('从磁盘选择')" :aria-label="t('从磁盘选择内核路径')" @click="pickPiBin">
                  <AppIcon name="folder" :size="16" />
                </AppButton>
              </div>
            </label>

            <div class="form-actions">
              <AppButton type="button" variant="secondary" @click="detectPi">
                <AppIcon name="search" :size="14" />
                <span>{{ t('自动检测') }}</span>
              </AppButton>
            </div>

            <p v-if="piDoctor?.found" class="form-message ok">{{ t('已找到内核：{0}', [piDoctor.path]) }}</p>
            <p v-else-if="piDoctor?.error" class="form-message err">{{ piDoctor.error }}</p>
          </div>

          <div v-if="loading" class="models-list" role="status" :aria-label="t('正在加载设置…')">
            <div v-for="n in 2" :key="n" class="sk-card">
              <span class="skeleton sk-line tall w-40"></span>
              <span class="skeleton sk-line w-80"></span>
              <span class="skeleton sk-line w-60"></span>
              <span class="skeleton sk-line w-30"></span>
            </div>
          </div>
          <div v-else-if="!hasModels && !error" class="empty-state">
            <div class="empty-icon"><AppIcon name="cpu" :size="20" /></div>
            <p class="empty-title">{{ t('还没有模型') }}</p>
            <p class="empty-hint">{{ t('点击「新增模型」添加第一个对话模型。') }}</p>
          </div>

          <div class="models-list">
            <div
              v-for="m in models"
              :key="m.id"
              class="model-card"
              :class="{ expanded: expandedIds.has(m.id), default: defaultModelId === m.id }"
            >
              <div class="model-header" @click="toggleExpand(m.id)">
                <div class="model-title">
                  <AppIcon name="cpu" :size="14" />
                  <span class="model-name">{{ m.name || m.model }}</span>
                  <span class="model-provider">{{ providerLabel(m.provider) }}</span>
                </div>
                <div class="model-badges">
                  <span v-if="defaultModelId === m.id" class="badge default">{{ t('默认') }}</span>
                  <span v-if="!m.enabled" class="badge disabled">{{ t('已禁用') }}</span>
                </div>
                <div class="model-actions">
                  <AppCheckbox
                    :model-value="m.enabled"
                    :label="t('启用')"
                    @update:model-value="(v) => onEnabledChange(m.id, v)"
                    @click.stop
                  />
                  <AppButton
                    type="button"
                    variant="icon"
                    class="icon-btn"
                    :title="t('设为默认')"
                    :aria-label="t('设为默认模型')"
                    :disabled="defaultModelId === m.id"
                    @click.stop="setDefault(m.id)"
                  >
                    <AppIcon name="check-circle" :size="15" />
                  </AppButton>
                  <AppButton
                    type="button"
                    variant="icon"
                    class="icon-btn danger"
                    :title="t('删除')"
                    :aria-label="t('删除模型')"
                    @click.stop="removeModel(m.id)"
                  >
                    <AppIcon name="trash" :size="15" />
                  </AppButton>
                </div>
              </div>

              <div v-if="expandedIds.has(m.id)" class="model-body">
                <div class="form-grid">
                  <label class="field">
                    <span>{{ t('显示名') }}</span>
                    <AppInput v-model="m.name" :placeholder="t('例如：OpenAI 默认')" />
                  </label>

                  <label class="field">
                    <span>{{ t('服务商') }}</span>
                    <AppSelect v-model="m.provider" :options="providers" width="100%" />
                  </label>

                  <label class="field full">
                    <span>{{ t('模型名') }}</span>
                    <AppInput v-model="m.model" placeholder="gpt-4o-mini" />
                  </label>

                  <label class="field full">
                    <span>Base URL</span>
                    <AppInput v-model="m.base_url" placeholder="https://api.openai.com/v1" />
                  </label>

                  <label class="field full">
                    <span>API Key</span>
                    <div class="password-row">
                      <AppInput
                        v-model="m.api_key"
                        :type="showKey === m.id ? 'text' : 'password'"
                        placeholder="sk-..."
                        class="flex"
                      />
                      <AppButton
                        type="button"
                        variant="icon"
                        class="eye-btn"
                        :title="showKey === m.id ? t('隐藏') : t('显示')"
                        :aria-label="showKey === m.id ? t('隐藏 API Key') : t('显示 API Key')"
                        @click="showKey = showKey === m.id ? '' : m.id"
                      >
                        <AppIcon :name="showKey === m.id ? 'eye-off' : 'eye'" :size="16" />
                      </AppButton>
                    </div>
                  </label>

                  <!-- v-if 兜底：inputMap 缺条目时不渲染，避免读取 undefined.temperature 导致整页失活 -->
                  <label v-if="inputMap[m.id]" class="field">
                    <span>Temperature</span>
                    <AppInput v-model="inputMap[m.id].temperature" type="text" />
                  </label>

                  <label v-if="inputMap[m.id]" class="field">
                    <span>Max Tokens</span>
                    <AppInput v-model="inputMap[m.id].max_tokens" type="text" />
                  </label>
                </div>

                <div class="form-actions">
                  <AppButton
                    variant="secondary"
                    :disabled="testing === m.id"
                    @click="testModel(m)"
                  >
                    <AppIcon name="plug" :size="14" />
                    <span>{{ testing === m.id ? t('测试中…') : t('测试连接') }}</span>
                  </AppButton>
                </div>
              </div>
            </div>
          </div>

          <div class="form-actions">
            <AppButton variant="secondary" @click="addModel">
              <AppIcon name="plus" :size="14" />
              <span>{{ t('新增模型') }}</span>
            </AppButton>
            <AppButton variant="primary" :disabled="saving" @click="save">
              <AppIcon name="save" :size="14" />
              <span>{{ saving ? t('保存中…') : t('保存') }}</span>
            </AppButton>
          </div>

          <p v-if="message" class="form-message ok">{{ message }}</p>
          <p v-if="error" class="form-message err">{{ error }}</p>
        </section>

        <section v-else-if="tab === 'tools' || tab === 'flow'" class="settings-section">
          <h2>{{ currentTitle }}</h2>
          <p class="section-desc">{{ t('以下工具会写入 Pi 内核的 defaultTools 白名单。改动保存后需重启内核生效。') }}</p>
          <p v-if="toolError" class="form-message err">{{ toolError }}</p>
          <div class="tools-list">
            <div v-for="t in tools" :key="t.name" class="tool-row">
              <AppCheckbox v-model="t.active" :label="t.name" @update:model-value="(v) => toggleTool(t.name, v)" />
              <span class="tool-desc">{{ t.description }}</span>
            </div>
          </div>
        </section>

        <section v-else-if="tab === 'desktop' || tab === 'device'" class="settings-section">
          <h2>{{ currentTitle }}</h2>
          <p class="section-desc">{{ t('关闭主窗口后如何处理，以及是否随系统登录自动启动。驻留后台时调度器保持运行， 托盘菜单可随时打开主窗口、暂停主动任务或彻底退出。') }}</p>

          <div class="bg-card">
            <label class="field full">
              <span>{{ t('关闭主窗口时') }}</span>
              <AppSelect
                :model-value="bgInfo?.close_action ?? 'ask'"
                :options="closeActionOptions"
                width="100%"
                @update:model-value="changeCloseAction"
              />
            </label>
            <p class="bg-hint">{{ t('首次关闭会询问一次，选择后按此执行；选「每次询问」则保持弹窗。') }}</p>

            <div class="bg-row">
              <AppCheckbox
                :model-value="bgInfo?.autostart ?? false"
                :label="t('登录时自动启动 Pi Workbench')"
                @update:model-value="toggleAutostart"
              />
              <p class="bg-hint">{{ t('开启后随系统登录静默启动，不弹主窗口；托盘菜单可打开主窗口或退出。 登录项默认关闭，需要时在这里显式开启。') }}</p>
            </div>

            <div class="bg-row">
              <span class="bg-label">{{ t('当前状态') }}</span>
              <span class="bg-status">
                {{ bgInfo?.paused ? t('主动任务已暂停') : t('主动任务运行中') }} ·
                {{ bgInfo?.autostart ? t('登录项已开启') : t('登录项已关闭') }}
              </span>
            </div>

            <p class="bg-hint">{{ t('彻底退出：托盘菜单「退出」、Dock 右键退出或 Cmd+Q。退出时会停止调度、 停止内核并清理预授权策略文件；驻留态重复启动只会聚焦已有窗口。') }}</p>
            <p v-if="bgError" class="form-message err">{{ bgError }}</p>
          </div>
        </section>

        <section v-else-if="tab === 'shortcuts'" class="settings-section">
          <h2>{{ currentTitle }}</h2>
          <p class="section-desc">{{ t('当前可用的键盘快捷键。') }}</p>
          <div class="tools-list">
            <div v-for="s in shortcutRows" :key="s.keys" class="tool-row">
              <code class="sc-keys">{{ s.keys }}</code>
              <span class="tool-desc">{{ s.label }}</span>
            </div>
          </div>
        </section>

        <section v-else-if="tab === 'memory'" class="settings-section">
          <h2>{{ currentTitle }}</h2>
          <p class="section-desc">{{ t('记忆把对话里有长期价值的信息沉淀下来，后续会话会自动召回。') }}</p>
          <div class="bg-card">
            <label class="field full inline">
              <AppCheckbox
                :model-value="autoArchive"
                :label="t('会话结束后自动把产物归档进资料库')"
                @update:model-value="changeAutoArchive"
              />
            </label>
            <p class="bg-hint">{{ t('云端记忆依赖账户体系，当前版本不提供；本地记忆保存在资料库。') }}</p>
            <div class="settings-jump-actions">
              <AppButton variant="secondary" @click="router.push('/library?view=memory')">
                <AppIcon name="book" :size="14" />
                <span>{{ t('打开本地记忆') }}</span>
              </AppButton>
            </div>
          </div>
        </section>

        <section v-else-if="activeJump" class="settings-section">
          <h2>{{ currentTitle }}</h2>
          <p class="section-desc">{{ activeJump.desc }}</p>
          <div class="settings-jump-card">
            <div v-for="action in activeJump.actions" :key="action.label" class="settings-jump-row">
              <AppIcon :name="action.icon" :size="16" />
              <span>{{ action.label }}</span>
              <AppButton variant="secondary" size="sm" @click="runJump(action)">{{ t('前往') }}</AppButton>
            </div>
            <p v-if="!activeJump.actions.length" class="bg-hint">{{ t('此分区无需额外设置。') }}</p>
          </div>
        </section>

        <section v-else-if="tab === 'about'" class="settings-section">
          <h2>{{ currentTitle }}</h2>
          <div class="about-cards">
            <div class="about-card">
              <span class="about-label">{{ t('应用') }}</span>
              <span class="about-value">{{ APP_NAME }} v{{ APP_VERSION }}</span>
            </div>
            <div class="about-card">
              <span class="about-label">{{ t('Pi 内核') }}</span>
              <span class="about-value">pi-coding-agent {{ PI_VERSION }}</span>
            </div>
            <div class="about-card">
              <span class="about-label">{{ t('桌面壳') }}</span>
              <span class="about-value">Tauri 2</span>
            </div>
            <div class="about-card">
              <span class="about-label">{{ t('吉祥物') }}</span>
              <span class="about-value">{{ t('Pi 机器猫（3D 卡通）') }}</span>
            </div>
          </div>
        </section>
      </main>
    </div>
    <template #footer>
      <AppButton variant="secondary" @click="closeSettings">{{ t('关闭') }}</AppButton>
    </template>
  </AppModal>
</template>

<style src="./SettingsView.css" scoped></style>
