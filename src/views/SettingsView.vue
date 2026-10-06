<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { open as openFile } from '@tauri-apps/plugin-dialog'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppSelect, { type SelectOption } from '@/components/ui/AppSelect.vue'
import AppCheckbox from '@/components/ui/AppCheckbox.vue'
import { describeIpcError } from '@/composables/useRuntime'
import { APP_NAME, APP_VERSION, PI_VERSION } from '@/version'

type Tab = 'model' | 'tools' | 'about'

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
  language?: string
  /** Pi 可执行文件绝对路径；null/空 = 后端自动探测。 */
  pi_bin?: string | null
}

const tab = ref<Tab>('model')
const saving = ref(false)
const testing = ref<string | null>(null)
const message = ref('')
const error = ref('')
const toolError = ref('')

const providers: SelectOption[] = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'azure', label: 'Azure OpenAI' },
  { value: 'local', label: 'Local / vLLM' },
  { value: 'custom', label: '自定义' },
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
    name: '新模型',
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
    piDoctor.value = { found: false, error: describeIpcError(e, '内核自检') }
  }
}

async function pickPiBin() {
  try {
    const picked = await openFile({ multiple: false, title: '选择 pi 可执行文件' })
    const p = Array.isArray(picked) ? picked[0] : picked
    if (p) piBin.value = p
  } catch {
    // 取消选择：保持原值
  }
}

async function load() {
  try {
    const s = await invoke<AppSettings>('settings_load')
    models.value = s.models?.length ? s.models : [defaultModel()]
    defaultModelId.value = s.default_model_id ?? models.value[0]?.id ?? ''
    piBin.value = s.pi_bin ?? ''
    expandedIds.value = new Set([defaultModelId.value])
    inputMap.value = {}
    for (const m of models.value) syncInputMap(m.id, m)
    message.value = ''
    error.value = ''
  } catch (e) {
    error.value = describeIpcError(e, '读取设置')
  }
}

async function save() {
  saving.value = true
  message.value = ''
  error.value = ''
  applyInputs()
  try {
    await invoke('settings_save', {
      settings: {
        models: models.value,
        default_model_id: defaultModelId.value,
        pi_bin: piBin.value.trim() || null,
      },
    })
    // 模型是启动参数注入内核的，改完必须重启才生效；内核没在跑时后端会跳过。
    const restarted = await invoke<boolean>('pi_restart').catch(() => false)
    // 路径可能刚改过：重启后立刻自检，让用户当场知道内核现在能不能起来。
    await detectPi()
    message.value = restarted ? '已保存，内核已重启生效' : '已保存'
  } catch (e) {
    error.value = describeIpcError(e, '保存设置')
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
    error.value = `${m.name}: ${describeIpcError(e, '连通性测试')}`
  } finally {
    testing.value = null
  }
}

function addModel() {
  const m = defaultModel()
  m.name = `模型 ${models.value.length + 1}`
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
    toolError.value = describeIpcError(e, '读取工具列表')
  }
}

function toolDescription(name: string) {
  const map: Record<string, string> = {
    read: '读取项目文件内容',
    bash: '执行 Shell 命令',
    edit: '编辑项目文件',
    write: '写入新文件',
    search: '在项目中搜索',
    browser: '操作智能体浏览器',
    python: '执行 Python 代码',
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
    message.value = restarted ? '工具白名单已更新，内核已重启生效' : '工具白名单已更新'
  } catch (e) {
    toolError.value = describeIpcError(e, '更新工具白名单')
  }
}

onMounted(() => {
  load()
  loadTools()
  // 一进设置就自检：找不到 pi 时模型配得再对也跑不起来，这条要最先看见。
  void detectPi()
})
</script>

<template>
  <div class="settings">
    <header class="settings-header">
      <h1>设置</h1>
    </header>

    <div class="settings-body">
      <aside class="settings-tabs">
        <button :class="{ active: tab === 'model' }" @click="tab = 'model'">
          <AppIcon name="cpu" :size="16" />
          <span>模型配置</span>
        </button>
        <button :class="{ active: tab === 'tools' }" @click="tab = 'tools'">
          <AppIcon name="tool" :size="16" />
          <span>工具激活</span>
        </button>
        <button :class="{ active: tab === 'about' }" @click="tab = 'about'">
          <AppIcon name="info" :size="16" />
          <span>关于</span>
        </button>
      </aside>

      <main class="settings-main">
        <section v-if="tab === 'model'" class="settings-section">
          <h2>模型配置</h2>
          <p class="section-desc">支持配置多个模型，可切换默认模型。API Key 仅保存在本地配置文件中，不会回显到日志。</p>

          <!-- 内核排在最前：找不到 pi 时点发送毫无反应，模型配得再对也跑不起来。 -->
          <div class="kernel-card">
            <div class="kernel-head">
              <AppIcon name="terminal" :size="14" />
              <strong>Pi 内核</strong>
              <span class="muted">桌面 App 的 PATH 里常没有 pi，找不到时发送无响应</span>
            </div>

            <label class="field full">
              <span>pi 可执行文件（留空 = 自动探测）</span>
              <div class="password-row">
                <AppInput v-model="piBin" placeholder="/Users/.../bin/pi" class="flex" />
                <button type="button" class="eye-btn" title="从磁盘选择" @click="pickPiBin">
                  <AppIcon name="folder" :size="16" />
                </button>
              </div>
            </label>

            <div class="form-actions">
              <button type="button" class="tool-btn" @click="detectPi">
                <AppIcon name="search" :size="14" />
                <span>自动检测</span>
              </button>
            </div>

            <p v-if="piDoctor?.found" class="form-message ok">已找到内核：{{ piDoctor.path }}</p>
            <p v-else-if="piDoctor?.error" class="form-message err">{{ piDoctor.error }}</p>
          </div>

          <div v-if="!hasModels" class="market-empty">
            <div class="empty-icon"><AppIcon name="cpu" :size="32" /></div>
            <strong>还没有模型</strong>
            <span class="muted">点击「新增模型」添加第一个对话模型。</span>
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
                  <span v-if="defaultModelId === m.id" class="badge default">默认</span>
                  <span v-if="!m.enabled" class="badge disabled">已禁用</span>
                </div>
                <div class="model-actions">
                  <AppCheckbox
                    :model-value="m.enabled"
                    label="启用"
                    @update:model-value="(v) => onEnabledChange(m.id, v)"
                    @click.stop
                  />
                  <button
                    type="button"
                    class="icon-btn"
                    title="设为默认"
                    :disabled="defaultModelId === m.id"
                    @click.stop="setDefault(m.id)"
                  >
                    <AppIcon name="check-circle" :size="15" />
                  </button>
                  <button
                    type="button"
                    class="icon-btn danger"
                    title="删除"
                    @click.stop="removeModel(m.id)"
                  >
                    <AppIcon name="trash" :size="15" />
                  </button>
                </div>
              </div>

              <div v-if="expandedIds.has(m.id)" class="model-body">
                <div class="form-grid">
                  <label class="field">
                    <span>显示名</span>
                    <AppInput v-model="m.name" placeholder="例如：OpenAI 默认" />
                  </label>

                  <label class="field">
                    <span>服务商</span>
                    <AppSelect v-model="m.provider" :options="providers" width="100%" />
                  </label>

                  <label class="field full">
                    <span>模型名</span>
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
                      <button
                        type="button"
                        class="eye-btn"
                        :title="showKey === m.id ? '隐藏' : '显示'"
                        @click="showKey = showKey === m.id ? '' : m.id"
                      >
                        <AppIcon :name="showKey === m.id ? 'eye-off' : 'eye'" :size="16" />
                      </button>
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
                  <button
                    class="tool-btn"
                    :disabled="testing === m.id"
                    @click="testModel(m)"
                  >
                    <AppIcon name="plug" :size="14" />
                    <span>{{ testing === m.id ? '测试中…' : '测试连接' }}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div class="form-actions">
            <button class="tool-btn" @click="addModel">
              <AppIcon name="plus" :size="14" />
              <span>新增模型</span>
            </button>
            <button class="tool-btn primary" :disabled="saving" @click="save">
              <AppIcon name="save" :size="14" />
              <span>{{ saving ? '保存中…' : '保存' }}</span>
            </button>
          </div>

          <p v-if="message" class="form-message ok">{{ message }}</p>
          <p v-if="error" class="form-message err">{{ error }}</p>
        </section>

        <section v-else-if="tab === 'tools'" class="settings-section">
          <h2>工具激活</h2>
          <p class="section-desc">以下工具会写入 Pi 内核的 defaultTools 白名单。改动保存后需重启内核生效。</p>
          <p v-if="toolError" class="form-message err">{{ toolError }}</p>
          <div class="tools-list">
            <div v-for="t in tools" :key="t.name" class="tool-row">
              <AppCheckbox v-model="t.active" :label="t.name" @update:model-value="(v) => toggleTool(t.name, v)" />
              <span class="tool-desc">{{ t.description }}</span>
            </div>
          </div>
        </section>

        <section v-else-if="tab === 'about'" class="settings-section">
          <h2>关于</h2>
          <div class="about-cards">
            <div class="about-card">
              <span class="about-label">应用</span>
              <span class="about-value">{{ APP_NAME }} v{{ APP_VERSION }}</span>
            </div>
            <div class="about-card">
              <span class="about-label">Pi 内核</span>
              <span class="about-value">pi-coding-agent {{ PI_VERSION }}</span>
            </div>
            <div class="about-card">
              <span class="about-label">桌面壳</span>
              <span class="about-value">Tauri 2</span>
            </div>
            <div class="about-card">
              <span class="about-label">吉祥物</span>
              <span class="about-value">Pi 机器猫（3D 卡通）</span>
            </div>
          </div>
        </section>
      </main>
    </div>
  </div>
</template>

<style src="./SettingsView.css" scoped></style>
