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
import { APP_NAME, APP_VERSION, PI_VERSION } from '@/version'

type Tab = 'general' | 'model' | 'tools' | 'background' | 'about'
type LanguageChoice = 'system' | 'zh-CN' | 'en-US'

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
}

const tab = ref<Tab>('general')
const router = useRouter()

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
const rawSettings = ref<AppSettings | null>(null)

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
  // 一进设置就自检：找不到 pi 时模型配得再对也跑不起来，这条要最先看见。
  void detectPi()
})
</script>

<template>
  <AppModal :open="true" :title="t('设置')" size="page" @close="closeSettings">
    <div class="settings-body">
      <aside class="settings-tabs" role="tablist" :aria-label="t('设置分区')" @keydown="onTablistKeydown">
        <AppButton variant="tab" role="tab" :aria-selected="tab === 'general'" :tabindex="tab === 'general' ? 0 : -1" :class="{ active: tab === 'general' }" @click="tab = 'general'">
          <AppIcon name="settings" :size="16" />
          <span>{{ t('通用') }}</span>
        </AppButton>
        <AppButton variant="tab" role="tab" :aria-selected="tab === 'model'" :tabindex="tab === 'model' ? 0 : -1" :class="{ active: tab === 'model' }" @click="tab = 'model'">
          <AppIcon name="cpu" :size="16" />
          <span>{{ t('模型配置') }}</span>
        </AppButton>
        <AppButton variant="tab" role="tab" :aria-selected="tab === 'tools'" :tabindex="tab === 'tools' ? 0 : -1" :class="{ active: tab === 'tools' }" @click="tab = 'tools'">
          <AppIcon name="tool" :size="16" />
          <span>{{ t('工具激活') }}</span>
        </AppButton>
        <AppButton variant="tab" role="tab" :aria-selected="tab === 'background'" :tabindex="tab === 'background' ? 0 : -1" :class="{ active: tab === 'background' }" @click="tab = 'background'">
          <AppIcon name="clock" :size="16" />
          <span>{{ t('后台与启动') }}</span>
        </AppButton>
        <AppButton variant="tab" role="tab" :aria-selected="tab === 'about'" :tabindex="tab === 'about' ? 0 : -1" :class="{ active: tab === 'about' }" @click="tab = 'about'">
          <AppIcon name="info" :size="16" />
          <span>{{ t('关于') }}</span>
        </AppButton>
      </aside>

      <main class="settings-main">
        <section v-if="tab === 'general'" class="settings-section">
          <h2>{{ t('通用') }}</h2>
          <p class="section-desc">{{ t('界面语言只影响 Pi Workbench 的界面与系统提示，不改变模型输出。切换语言不会重启内核。') }}</p>
          <label class="field full">
            <span>{{ t('界面语言') }}</span>
            <AppSelect
              :model-value="language"
              :options="languageOptions"
              width="100%"
              @update:model-value="changeLanguage"
            />
          </label>
          <p v-if="error" class="form-message err">{{ error }}</p>
        </section>

        <section v-else-if="tab === 'model'" class="settings-section">
          <h2>{{ t('模型配置') }}</h2>
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
              <AppButton type="button" variant="secondary" class="tool-btn" @click="detectPi">
                <AppIcon name="search" :size="14" />
                <span>{{ t('自动检测') }}</span>
              </AppButton>
            </div>

            <p v-if="piDoctor?.found" class="form-message ok">{{ t('已找到内核：{0}', [piDoctor.path]) }}</p>
            <p v-else-if="piDoctor?.error" class="form-message err">{{ piDoctor.error }}</p>
          </div>

          <p v-if="loading" class="load-state">{{ t('正在加载设置…') }}</p>
          <div v-else-if="!hasModels" class="market-empty">
            <div class="empty-icon"><AppIcon name="cpu" :size="32" /></div>
            <strong>{{ t('还没有模型') }}</strong>
            <span class="muted">{{ t('点击「新增模型」添加第一个对话模型。') }}</span>
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
                    class="tool-btn"
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
            <AppButton variant="secondary" class="tool-btn" @click="addModel">
              <AppIcon name="plus" :size="14" />
              <span>{{ t('新增模型') }}</span>
            </AppButton>
            <AppButton variant="primary" class="tool-btn primary" :disabled="saving" @click="save">
              <AppIcon name="save" :size="14" />
              <span>{{ saving ? t('保存中…') : t('保存') }}</span>
            </AppButton>
          </div>

          <p v-if="message" class="form-message ok">{{ message }}</p>
          <p v-if="error" class="form-message err">{{ error }}</p>
        </section>

        <section v-else-if="tab === 'tools'" class="settings-section">
          <h2>{{ t('工具激活') }}</h2>
          <p class="section-desc">{{ t('以下工具会写入 Pi 内核的 defaultTools 白名单。改动保存后需重启内核生效。') }}</p>
          <p v-if="toolError" class="form-message err">{{ toolError }}</p>
          <div class="tools-list">
            <div v-for="t in tools" :key="t.name" class="tool-row">
              <AppCheckbox v-model="t.active" :label="t.name" @update:model-value="(v) => toggleTool(t.name, v)" />
              <span class="tool-desc">{{ t.description }}</span>
            </div>
          </div>
        </section>

        <section v-else-if="tab === 'background'" class="settings-section">
          <h2>{{ t('后台与启动') }}</h2>
          <p class="section-desc">{{ t('关闭主窗口后如何处理，以及是否随系统登录自动启动。驻留后台时调度器保持运行， 托盘菜单可随时打开主窗口、暂停主动任务或彻底退出。') }}</p>

          <div class="bg-card">
            <label class="field full">
              <span>{{ t('关闭主窗口时') }}</span>
              <AppSelect
                :model-value="bgInfo.closeAction"
                :options="closeActionOptions"
                width="100%"
                @update:model-value="changeCloseAction"
              />
            </label>
            <p class="bg-hint">{{ t('首次关闭会询问一次，选择后按此执行；选「每次询问」则保持弹窗。') }}</p>

            <div class="bg-row">
              <AppCheckbox
                :model-value="bgInfo.autostart"
                :label="t('登录时自动启动 Pi Workbench')"
                @update:model-value="toggleAutostart"
              />
              <p class="bg-hint">{{ t('开启后随系统登录静默启动，不弹主窗口；托盘菜单可打开主窗口或退出。 登录项默认关闭，需要时在这里显式开启。') }}</p>
            </div>

            <div class="bg-row">
              <span class="bg-label">{{ t('当前状态') }}</span>
              <span class="bg-status">
                {{ bgInfo.paused ? t('主动任务已暂停') : t('主动任务运行中') }} ·
                {{ bgInfo.autostart ? t('登录项已开启') : t('登录项已关闭') }}
              </span>
            </div>

            <p class="bg-hint">{{ t('彻底退出：托盘菜单「退出」、Dock 右键退出或 Cmd+Q。退出时会停止调度、 停止内核并清理预授权策略文件；驻留态重复启动只会聚焦已有窗口。') }}</p>
            <p v-if="bgError" class="form-message err">{{ bgError }}</p>
          </div>
        </section>

        <section v-else-if="tab === 'about'" class="settings-section">
          <h2>{{ t('关于') }}</h2>
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
