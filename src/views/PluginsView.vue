<script setup lang="ts">
import { t } from '@/i18n'
/**
 * 插件市场 —— 发现社区插件与本地安装入口。
 *
 * 当前能力边界：
 *  - 列表来自后端 `extensions_list`（pi-manifest.json 声明 + extensions/ 目录实体）。
 *  - 远端社区市场没有服务端，列表里不塞 mock；需要新扩展时走「从链接安装」，
 *    由后端下载并落盘到 extensions/，与技能市场同一套地址校验与限额。
 */
import { computed, onMounted, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { onTablistKeydown } from '@/composables/useTablist'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import { toolsActivate } from '@/composables/useTools'
import { currentTheme, toggleTheme, type Theme } from '@/theme'
import { APP_VERSION, PI_VERSION } from '@/version'
import { listOf } from '@/utils/ipc'

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

const TABS = computed<{ key: Tab; label: string }[]>(() => [
  { key: 'discover', label: t('发现') },
  { key: 'themes', label: t('主题') },
  { key: 'favorites', label: t('收藏') },
  { key: 'installed', label: t('已安装') },
  { key: 'advanced', label: t('高级') },
])

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
  { key: 'all', label: t('全部') },
  ...[...new Set(installed.value.map((i) => i.kind || 'unknown'))].map((k) => ({
    key: k,
    label: k,
  })),
])

const allRows = computed<Row[]>(() =>
  installed.value.map((i) => ({
    id: i.id,
    name: i.name,
    // AUDIT-013：后端清单没有作者/版本字段，不再拿 App 版本冒充扩展版本、
    // 不再统一写成 'local'——没有就是没有，显示「未知」。
    author: t('未知'),
    version: t('未知'),
    description: i.description || t('未读取到说明'),
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
    marketNote.value = t('「{0}」已{1}', [label, enabled ? t('启用') : t('禁用')])
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
    marketNote.value = t('已启用 {0} 个工具', [allToolNames.value.length])
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
    error.value = t('浏览器拒绝了剪贴板访问，请手动复制')
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
    installed.value = await listOf(invoke<ExtensionInfo[]>('extensions_list'))
  } catch (e) {
    error.value = e instanceof Error ? e.message : t('插件清单不可用')
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
    installNote.value = t('「{0}」已写入 {1}，重启内核后加载', [res.name, res.path])
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
    <div class="community-hero">
      <div>
        <h1>{{ t('发现社区插件') }}</h1>
        <p>
          {{ t('已装 {0} 个扩展 · 列表只含本机已声明的扩展', [installedCount]) }}
          <AppButton variant="text" class="hero-link" @click="showInstallModal = true">{{ t('从链接安装扩展') }}<AppIcon name="arrow-right" :size="12" />
          </AppButton>
        </p>
      </div>
    </div>

    <div class="market-toolbar">
      <nav class="market-tabs" role="tablist" :aria-label="t('插件视图')" @keydown="onTablistKeydown">
        <AppButton
          v-for="t in TABS"
          :key="t.key"
          variant="tab"
          role="tab"
          :aria-selected="tab === t.key"
          :tabindex="tab === t.key ? 0 : -1"
          class="market-tab"
          :class="{ active: tab === t.key }"
          @click="tab = t.key"
        >
          {{ t.label }}
          <span v-if="t.key === 'installed'" class="tab-badge">{{ installedCount }}</span>
        </AppButton>
      </nav>

      <div class="market-tools">
        <div class="market-tags">
          <AppButton
            v-for="t in TAGS"
            :key="t.key"
            variant="chip"
            class="market-tag"
            :class="{ active: tag === t.key }"
            :aria-pressed="tag === t.key"
            @click="tag = t.key"
          >
            {{ t.label }}{{ t.key === 'all' ? ` (${tagCount(t.key)})` : '' }}
          </AppButton>
        </div>

        <div class="market-search">
          <AppIcon name="search" :size="14" />
          <AppInput v-model="keyword" :placeholder="t('搜索插件')" />
        </div>

        <AppButton
          variant="text"
          class="text-btn"
          :disabled="!disabledCount"
          :title="disabledCount ? t('把所有扩展的工具重新写进 defaultTools') : t('已全部启用')"
          @click="enableAll"
        >{{ t('全部启用 ({0})', [disabledCount]) }}</AppButton>

        <AppButton variant="secondary"  :title="t('复制内核与扩展诊断信息')" @click="copyDiagnostics">
          <AppIcon name="copy" :size="13" />
          <span>{{ t('诊断信息') }}</span>
        </AppButton>
      </div>
    </div>

      <p v-if="marketNote" class="market-note" role="status">{{ marketNote }}</p>
      <p v-if="error" class="state-error" role="alert">{{ error }}</p>
      <div
        v-if="busy"
        class="sk-list market-list"
        role="status"
        :aria-label="t('正在读取插件清单…')"
      >
        <div v-for="n in 4" :key="n" class="sk-row">
          <div class="sk-lines">
            <span class="skeleton sk-line tall w-30"></span>
            <span class="skeleton sk-line w-80"></span>
            <span class="skeleton sk-line w-60"></span>
          </div>
          <span class="skeleton sk-act"></span>
        </div>
      </div>

      <div v-else-if="tab === 'themes'" class="empty-state">
        <p class="empty-title">{{ t('主题') }}</p>
        <p class="empty-hint">{{ t('外观主题由应用侧管理，即时切换，无需重启。') }}</p>
        <AppButton variant="secondary" class="theme-pick" @click="pickTheme">
          <AppIcon :name="themeNow === 'dark' ? 'moon' : 'sun'" :size="14" />
          {{ themeNow === 'dark' ? t('切到浅色') : t('切到深色') }}
        </AppButton>
      </div>

      <div v-else-if="tab === 'favorites'" class="empty-state">
        <p class="empty-title">{{ t('还没有收藏') }}</p>
        <p class="empty-hint">{{ t('收藏需要账号体系，当前版本尚未接入登录。') }}</p>
      </div>

      <div v-else-if="tab === 'advanced'" class="empty-state">
        <p class="empty-title">{{ t('高级设置') }}</p>
        <p class="empty-hint">{{ t('pi {0} · 扩展 {1} 个 · 扩展目录 {2}', [PI_VERSION, installed.length, installed[0]?.path.split('/').slice(0, -1).join('/') || t('未知')]) }}
        </p>
      </div>

      <div v-else-if="!rows.length" class="empty-state">
        <p class="empty-title">{{ keyword ? t('没有匹配的插件') : t('暂无插件') }}</p>
        <p class="empty-hint">{{ keyword ? t('保留搜索词，可清除后重试。') : t('切换标签或稍后再试。') }}</p>
      </div>

    <div v-else class="market-list">
      <article v-for="p in rows" :key="p.id" class="market-row">
        <div class="row-body">
          <div class="row-title">
            <strong :title="p.name">{{ p.name }}</strong>
            <span class="row-meta">
              <i v-if="p.author && p.author !== t('未知')">@{{ p.author }}</i>
              <i v-if="p.version && p.version !== t('未知')">{{ p.version }}</i>
            </span>
            <span v-for="(tag, idx) in p.tags" :key="idx" class="row-tag">{{ tag }}</span>
          </div>
          <p class="row-desc" :title="p.description">{{ p.description }}</p>
          <p v-if="p.hasTools" class="row-tools" :title="t('工具：{0}', [p.tools.join('、')])">{{ t('工具：{0}', [p.tools.join('、')]) }}</p>
        </div>
        <div class="row-actions">
          <AppButton
            variant="secondary"
            class="row-install"
            :class="{ installed: p.enabled }"
            :disabled="!p.hasTools"
            :title="
              p.hasTools
                ? p.enabled
                  ? t('从内核默认工具里移除')
                  : t('把工具写进内核默认工具')
                : t('该扩展不提供工具')
            "
            @click="setExtensionEnabled(p.tools, !p.enabled, p.name)"
          >
            {{ p.hasTools ? (p.enabled ? t('已启用') : t('启用')) : t('无工具') }}
          </AppButton>
        </div>
      </article>
    </div>

    <!-- AUDIT-013：手搓 modal-mask/modal-card → UI Kit AppModal -->
    <AppModal :open="showInstallModal" :title="t('从链接安装扩展')" size="md" @close="showInstallModal = false">
      <p class="modal-desc">{{ t('粘贴一个') }}<code>.ts</code>{{ t('扩展直链。后端只放行 http/https，下载后按文件名白名单落盘到') }}<code>extensions/</code>{{ t('，重启内核后由 Pi 加载。') }}</p>
      <AppInput
        v-model="installUrl"
        placeholder="https://example.com/my-ext.ts"
        @keyup.enter="installExtension"
      />
      <p v-if="installError" class="state-error" role="alert">{{ installError }}</p>
      <p v-if="installNote" class="market-note" role="status">{{ installNote }}</p>
      <template #footer>
        <AppButton
          variant="primary"
          :disabled="!installUrl.trim() || installing"
          @click="installExtension"
        >
          {{ installing ? t('安装中…') : t('安装') }}
        </AppButton>
      </template>
    </AppModal>
  </section>
</template>

<style src="./PluginsView.css" scoped></style>
