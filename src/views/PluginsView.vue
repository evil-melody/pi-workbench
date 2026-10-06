<script setup lang="ts">
/**
 * 插件市场 —— 发现社区插件与本地安装入口。
 *
 * 当前能力边界：
 *  - 列表来自后端 `extensions_list`（capabilities.json 声明 + extensions/ 目录实体）。
 *  - 远端社区市场没有服务端，列表里不塞 mock；需要新扩展时走「从链接安装」，
 *    由后端下载并落盘到 extensions/，与技能市场同一套地址校验与限额。
 */
import { computed, onMounted, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppInput from '@/components/ui/AppInput.vue'
import { toolsActivate } from '@/composables/useTools'
import { currentTheme, toggleTheme, type Theme } from '@/theme'
import { APP_VERSION, PI_VERSION } from '@/version'

type Tab = 'discover' | 'themes' | 'favorites' | 'installed' | 'advanced'

interface ExtensionInfo {
  id: string
  name: string
  description: string
  kind: string
  path: string
  tools: string[]
  enabled: boolean
}

/** 一行的展示数据。所有字段都来自后端真实清单，没有 mock 占位。 */
interface Row {
  id: string
  name: string
  author: string
  version: string
  description: string
  tags: string[]
  /** 该扩展是否提供工具（决定启用按钮是否可用）。 */
  hasTools: boolean
  enabled: boolean
  tools: string[]
  path: string
}

const TABS: { key: Tab; label: string }[] = [
  { key: 'discover', label: '发现' },
  { key: 'themes', label: '主题' },
  { key: 'favorites', label: '收藏' },
  { key: 'installed', label: '已安装' },
  { key: 'advanced', label: '高级' },
]

const keyword = ref('')
const tab = ref<Tab>('discover')
const tag = ref<string>('all')
const installed = ref<ExtensionInfo[]>([])
const busy = ref(true)
const error = ref('')

const installedCount = computed(() => installed.value.length)
/** 「全部启用」的候选：扩展的启用态由它的工具是否落进 defaultTools 决定。 */
const disabledCount = computed(() => installed.value.filter((i) => !i.enabled).length)
const allToolNames = computed(() => [
  ...new Set(installed.value.flatMap((i) => i.tools)),
])

/** 标签取自真实数据的 kind，不再写死一套永远匹配不到的社区分类。 */
const TAGS = computed<{ key: string; label: string }[]>(() => [
  { key: 'all', label: '全部' },
  ...[...new Set(installed.value.map((i) => i.kind || 'unknown'))].map((k) => ({
    key: k,
    label: k,
  })),
])

const allRows = computed<Row[]>(() =>
  installed.value.map((i) => ({
    id: i.id,
    name: i.name,
    author: 'local',
    version: `v${APP_VERSION}`,
    description: i.description || '未读取到说明',
    tags: [i.kind || 'unknown'],
    hasTools: i.tools.length > 0,
    enabled: i.enabled,
    tools: i.tools,
    path: i.path,
  })),
)

const rows = computed<Row[]>(() => {
  const k = keyword.value.trim().toLowerCase()
  // 「已安装」只看已启用的；「发现」看全部，未启用的在这里切回即可。
  const base =
    tab.value === 'installed' ? allRows.value.filter((r) => r.enabled) : allRows.value
  return base.filter((p) => {
    if (tag.value !== 'all' && !p.tags.includes(tag.value)) return false
    if (!k) return true
    return p.name.toLowerCase().includes(k) || p.description.toLowerCase().includes(k)
  })
})

async function setExtensionEnabled(tools: string[], enabled: boolean, label: string) {
  if (!tools.length) return
  try {
    await toolsActivate(tools, enabled)
    marketNote.value = `「${label}」已${enabled ? '启用' : '禁用'}`
  } catch (e: any) {
    error.value = String(e?.message ?? e)
    marketNote.value = ''
  }
  await load()
}

async function enableAll() {
  if (!allToolNames.value.length) return
  try {
    await toolsActivate(allToolNames.value, true)
    marketNote.value = `已启用 ${allToolNames.value.length} 个工具`
  } catch (e: any) {
    error.value = String(e?.message ?? e)
  }
  await load()
}

/** 诊断信息：内核版本 + 每个扩展的启用态与路径，直接给到剪贴板，省得用户猜。 */
async function copyDiagnostics() {
  const lines = [
    `Pi Workbench ${APP_VERSION} / pi ${PI_VERSION}`,
    `extensions: ${installed.value.length}`,
    ...installed.value.map(
      (i) => `- ${i.id} | ${i.kind} | enabled=${i.enabled} | tools=${i.tools.join(',') || '-'} | ${i.path}`,
    ),
  ]
  try {
    await navigator.clipboard.writeText(lines.join('\n'))
  } catch {
    error.value = '浏览器拒绝了剪贴板访问，请手动复制'
  }
}

const marketNote = ref('')

/** 主题 tab 接应用真实主题系统：light/dark 即时切换，与侧栏开关共用同一份持久化。 */
const themeNow = ref<Theme>(currentTheme())
function pickTheme() {
  themeNow.value = toggleTheme()
}

async function load() {
  busy.value = true
  error.value = ''
  marketNote.value = ''
  try {
    installed.value = await invoke<ExtensionInfo[]>('extensions_list')
  } catch (e) {
    error.value = e instanceof Error ? e.message : '插件清单不可用'
    installed.value = []
  } finally {
    busy.value = false
  }
}

function tagCount(key: string) {
  if (key === 'all') return allRows.value.length
  return allRows.value.filter((p) => p.tags.includes(key)).length
}

const showInstallModal = ref(false)
const installUrl = ref('')
const installing = ref(false)
const installError = ref('')
const installNote = ref('')

/** 从任意 .ts 直链装扩展：后端下载并落盘到 extensions/，重启内核后由 Pi 加载。 */
async function installExtension() {
  const url = installUrl.value.trim()
  if (!url) return
  installing.value = true
  installError.value = ''
  installNote.value = ''
  try {
    const res = await invoke<ExtensionInfo>('extensions_install_from_url', { url })
    installNote.value = `「${res.name}」已写入 ${res.path}，重启内核后加载`
    installUrl.value = ''
    await load()
  } catch (e: any) {
    installError.value = String(e?.message ?? e)
  }
  installing.value = false
}

onMounted(load)
</script>

<template>
  <section class="wd-community">
    <header class="community-head">
      <button class="back-link" @click="tab = 'discover'">
        <AppIcon name="arrow-left" :size="14" />
        <span>插件列表</span>
      </button>
    </header>

    <div class="community-hero">
      <span class="hero-icon"><AppIcon name="puzzle" :size="28" /></span>
      <div>
        <h1>发现社区插件</h1>
        <p>
          已装 {{ installedCount }} 个扩展
          <button class="hero-link" @click="showInstallModal = true">
            从链接安装扩展 <AppIcon name="arrow-right" :size="12" />
          </button>
        </p>
      </div>
    </div>

    <div class="market-section">
      <div class="market-section-head">
        <div class="market-section-title">
          <AppIcon name="grid" :size="16" />
          <strong>插件市场</strong>
          <button
            class="text-btn"
            :disabled="!disabledCount"
            :title="disabledCount ? '把所有扩展的工具重新写进 defaultTools' : '已全部启用'"
            @click="enableAll"
          >
            全部启用 ({{ disabledCount }})
          </button>
        </div>
        <button class="tool-btn" title="复制内核与扩展诊断信息" @click="copyDiagnostics">
          <AppIcon name="copy" :size="13" />
          <span>诊断信息</span>
        </button>
      </div>
      <p class="market-section-desc">
        远端社区市场没有服务端，列表只展示本机已声明的扩展；需要新扩展请从直链安装。
      </p>

      <nav class="market-tabs">
        <button
          v-for="t in TABS"
          :key="t.key"
          class="market-tab"
          :class="{ active: tab === t.key }"
          @click="tab = t.key"
        >
          {{ t.label }}
          <span v-if="t.key === 'installed'" class="tab-badge">{{ installedCount }}</span>
        </button>
      </nav>

      <div class="market-tags">
        <button
          v-for="t in TAGS"
          :key="t.key"
          class="market-tag"
          :class="{ active: tag === t.key }"
          @click="tag = t.key"
        >
          {{ t.label }}{{ t.key === 'all' ? ` (${tagCount(t.key)})` : '' }}
        </button>
      </div>

      <div class="market-search">
        <AppIcon name="search" :size="14" />
        <AppInput v-model="keyword" placeholder="搜索插件，例如：通知、终端、记忆" />
      </div>

      <p v-if="marketNote" class="market-note" role="status">{{ marketNote }}</p>
      <p v-if="error" class="market-note" role="alert">{{ error }}</p>
      <div v-if="busy" class="market-note" role="status">正在读取插件清单…</div>

      <div v-else-if="tab === 'themes'" class="market-empty">
        <strong>主题</strong>
        <span class="muted">外观主题由应用侧管理，即时切换，无需重启。</span>
        <button class="tool-btn theme-pick" @click="pickTheme">
          <AppIcon :name="themeNow === 'dark' ? 'moon' : 'sun'" :size="14" />
          {{ themeNow === 'dark' ? '切到浅色' : '切到深色' }}
        </button>
      </div>

      <div v-else-if="tab === 'favorites'" class="market-empty">
        <strong>还没有收藏</strong>
        <span class="muted">收藏需要账号体系，当前版本尚未接入登录。</span>
      </div>

      <div v-else-if="tab === 'advanced'" class="market-empty">
        <strong>高级设置</strong>
        <span class="muted">
          pi {{ PI_VERSION }} · 扩展 {{ installed.length }} 个 · 扩展目录
          {{ installed[0]?.path.split('/').slice(0, -1).join('/') || '未知' }}
        </span>
      </div>

      <div v-else-if="!rows.length" class="market-empty">
        <strong>{{ keyword ? '没有匹配的插件' : '暂无插件' }}</strong>
        <span class="muted">{{ keyword ? '保留搜索词，可清除后重试。' : '切换标签或稍后再试。' }}</span>
      </div>

      <div v-else class="market-list">
        <article v-for="p in rows" :key="p.id" class="market-row">
          <span class="row-icon">{{ (p.name || '?').slice(0, 1).toUpperCase() }}</span>
          <div class="row-body">
            <div class="row-title">
              <strong :title="p.name">{{ p.name }}</strong>
              <span class="row-meta">
                <i>@{{ p.author }}</i>
                <i>{{ p.version }}</i>
                <i v-if="p.enabled" class="row-flag">已载入</i>
              </span>
            </div>
            <p class="row-desc">{{ p.description }}</p>
            <div class="row-tags">
              <span v-for="(t, idx) in p.tags" :key="idx" class="row-tag">{{ t }}</span>
            </div>
            <p v-if="p.hasTools" class="row-tools">
              工具：{{ p.tools.join('、') }}
            </p>
          </div>
          <div class="row-actions">
            <button
              class="row-install"
              :class="{ installed: p.enabled }"
              :disabled="!p.hasTools"
              :title="
                p.hasTools
                  ? p.enabled
                    ? '从内核默认工具里移除'
                    : '把工具写进内核默认工具'
                  : '该扩展不提供工具'
              "
              @click="setExtensionEnabled(p.tools, !p.enabled, p.name)"
            >
              {{ p.hasTools ? (p.enabled ? '已启用' : '启用') : '无工具' }}
            </button>
          </div>
        </article>
      </div>
    </div>

    <div v-if="showInstallModal" class="modal-mask" @click.self="showInstallModal = false">
      <div class="modal-card" role="dialog" aria-modal="true" aria-label="从链接安装扩展">
        <header class="modal-head">
          <strong>从链接安装扩展</strong>
          <button class="text-btn" @click="showInstallModal = false">关闭</button>
        </header>
        <p class="modal-desc">
          粘贴一个 <code>.ts</code> 扩展直链。后端只放行 http/https，下载后按文件名白名单落盘到
          <code>extensions/</code>，重启内核后由 Pi 加载。
        </p>
        <AppInput
          v-model="installUrl"
          placeholder="https://example.com/my-ext.ts"
          @keyup.enter="installExtension"
        />
        <p v-if="installError" class="market-note" role="alert">{{ installError }}</p>
        <p v-if="installNote" class="market-note" role="status">{{ installNote }}</p>
        <footer class="modal-foot">
          <button
            class="tool-btn"
            :disabled="!installUrl.trim() || installing"
            @click="installExtension"
          >
            {{ installing ? '安装中…' : '安装' }}
          </button>
        </footer>
      </div>
    </div>
  </section>
</template>

<style src="./PluginsView.css" scoped></style>
