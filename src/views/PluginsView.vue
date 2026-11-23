<script setup lang="ts">
import { t } from '@/i18n'
/**
 * 插件市场 —— 发现社区插件与本地安装入口。
 *
 * 能力边界（#96 融入 Pi 原生包通道，复用不重建）：
 *  - 本地扩展行来自 `extensions_list`（pi-manifest 声明 + extensions/ 目录实体），
 *    加载/工具/卸载三层开关沿用 #78。
 *  - Pi 托管包（npm / git / 本地目录）来自 `pi_pkg_list`（解析 `pi list` 输出）；
 *    安装/卸载/更新一律透传 `pi install|remove|update`，源语法与落盘语义全交给 pi，
 *    本视图与后端都不复刻。
 *  - 可更新检测 `pi_pkg_check_updates` 走平台标准工具（npm view / git ls-remote），
 *    顶栏据此显示「N 个插件可更新」。
 *  - 生态推荐四卡是真实 npm 包，一键 `npm:<pkg>` 透传安装。
 */
import { computed, onMounted, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import { onTablistKeydown } from '@/composables/useTablist'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
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
  loaded: boolean
  removable: boolean
}

/** Pi 托管包条目（后端 `pi_pkg_list` 解析 `pi list` 得到，源与落盘路径由 pi 决定）。 */
interface PkgEntry {
  source: string
  installed_path: string
  scope: string
}

/** 可更新项（后端 `pi_pkg_check_updates`：npm 比版本、git 比 upstream 远端头）。 */
interface PkgUpdateInfo {
  source: string
  kind: string
  current: string
  latest: string
}

/** 一行的展示数据。所有字段都来自后端真实清单，没有 mock 占位。 */
interface Row {
  id: string
  name: string
  author: string
  version: string
  description: string
  tags: string[]
  /** 该扩展是否提供工具（决定工具级启用按钮是否可用）。 */
  hasTools: boolean
  enabled: boolean
  loaded: boolean
  removable: boolean
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
/** Pi 托管包清单（npm/git/本地），与本地扩展并列。 */
const pkgs = ref<PkgEntry[]>([])
/** 可更新项，按 source 建索引供行内查询。 */
const updates = ref<PkgUpdateInfo[]>([])
const checking = ref(false)
const busy = ref(true)
const error = ref('')

const installedCount = computed(() => installed.value.length)
/** 「全部启用」的候选：扩展的启用态由它的工具是否落进 defaultTools 决定。 */
const disabledCount = computed(() => installed.value.filter((i) => !i.enabled).length)
/** 加载层全关候选：当前正在加载的扩展（点完要重启内核）。 */
const loadedCount = computed(() => installed.value.filter((i) => i.loaded).length)
const allToolNames = computed(() => [
  ...new Set(installed.value.flatMap((i) => i.tools)),
])
const updatableCount = computed(() => updates.value.length)

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
    loaded: i.loaded,
    removable: i.removable,
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

/** 托管包行：合并可更新信息；搜索词同样过滤。 */
const managedRows = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  const upd = new Map(updates.value.map((u) => [u.source, u]))
  return pkgs.value
    .filter((p) => !k || p.source.toLowerCase().includes(k))
    .map((p) => ({ ...p, update: upd.get(p.source) ?? null }))
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

/** 加载层开关：物理移入/移出 extensions/；pi 0.87.1 只认文件位置，改完须重启内核。 */
async function setExtensionLoaded(ext: Row, loaded: boolean) {
  try {
    installed.value = await listOf(
      invoke<ExtensionInfo[]>('extensions_set_enabled', { id: ext.id, enabled: loaded }),
    )
    marketNote.value = t('「{0}」已{1}，重启内核后生效', [
      ext.name,
      loaded ? t('加载') : t('停用'),
    ])
    await restartKernel()
  } catch (e: any) {
    error.value = String(e?.message ?? e)
  }
}

/** 一键全关/恢复：排查扩展冲突时先全关，问题消失再逐个加回来。 */
async function setAllLoaded(loaded: boolean) {
  const targets = installed.value.filter((i) => (loaded ? !i.loaded : i.loaded))
  if (!targets.length) return
  try {
    for (const ext of targets) {
      installed.value = await listOf(
        invoke<ExtensionInfo[]>('extensions_set_enabled', { id: ext.id, enabled: loaded }),
      )
    }
    marketNote.value = loaded
      ? t('已恢复 {0} 个扩展，重启内核后生效', [targets.length])
      : t('已停用 {0} 个扩展，重启内核后生效', [targets.length])
    await restartKernel()
  } catch (e: any) {
    error.value = String(e?.message ?? e)
  }
}

async function removeExtension(ext: Row) {
  try {
    installed.value = await listOf(invoke<ExtensionInfo[]>('extensions_remove', { id: ext.id }))
    marketNote.value = t('「{0}」已卸载，重启内核后不再加载', [ext.name])
    await restartKernel()
  } catch (e: any) {
    error.value = String(e?.message ?? e)
  }
}

async function restartKernel() {
  try {
    const ok = await invoke<boolean>('pi_restart')
    if (ok) marketNote.value += t(' · 内核已重启')
  } catch {
    // 内核没在跑时跳过重启，不改变开关已落盘的事实。
  }
}

/** 诊断信息：内核版本 + 每个扩展的启用态与路径 + Pi 托管包，直接给到剪贴板。 */
async function copyDiagnostics() {
  const lines = [
    `Pi Workbench ${APP_VERSION} / pi ${PI_VERSION}`,
    `extensions: ${installed.value.length}`,
    ...installed.value.map(
      (i) => `- ${i.id} | ${i.kind} | enabled=${i.enabled} | tools=${i.tools.join(',') || '-'} | ${i.path}`,
    ),
    `pi packages: ${pkgs.value.length}`,
    ...pkgs.value.map((p) => `- ${p.source} | ${p.scope} | ${p.installed_path}`),
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

/** 托管包清单：透传 `pi list`，失败清空但不阻塞本地扩展列表（可能未装 pi）。 */
async function loadPkgs() {
  try {
    pkgs.value = await listOf(invoke<PkgEntry[]>('pi_pkg_list'))
  } catch {
    pkgs.value = []
  }
}

/** 更新检测：npm view / git ls-remote，逐项失败后端已降级跳过；整体失败静默清零。 */
async function checkUpdates() {
  checking.value = true
  try {
    updates.value = await listOf(invoke<PkgUpdateInfo[]>('pi_pkg_check_updates'))
  } catch {
    updates.value = []
  } finally {
    checking.value = false
  }
}

/** 顶栏「刷新」：重读托管包 + 重跑更新检测 + 重读本地扩展。 */
async function refreshAll() {
  marketNote.value = ''
  error.value = ''
  await Promise.all([load(), loadPkgs()])
  await checkUpdates()
  if (!error.value) marketNote.value = t('清单与更新状态已刷新')
}

function tagCount(key: string) {
  if (key === 'all') return allRows.value.length
  return allRows.value.filter((p) => p.tags.includes(key)).length
}

/** 旧「.ts 直链」弹窗（Workbench 原生活通道，与 Pi 托管包并列保留）。 */
const showInstallModal = ref(false)
const installUrl = ref('')
const installing = ref(false)
const installError = ref('')
const installNote = ref('')

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

// ── #96 DSH 形态「添加插件」弹窗：任意源透传 pi install，语义由 pi 解析 ──────────
const showAddModal = ref(false)
/** 安装源前缀模式：auto 原样透传，npm/git 由弹窗补前缀（避免用户记语法）。 */
type AddMode = 'auto' | 'npm' | 'git'
const addMode = ref<AddMode>('auto')
const addSource = ref('')
const addGuide = ref(false)
const adding = ref(false)
const addError = ref('')
const addNote = ref('')

const ADD_MODE_OPTIONS = computed(() => [
  { value: 'auto', label: t('自动识别') },
  { value: 'npm', label: t('npm 包') },
  { value: 'git', label: t('Git 仓库') },
])

/** 组合最终源：npm/git 模式补前缀，auto 原样交 pi。 */
function composedSource(): string {
  const raw = addSource.value.trim()
  if (!raw) return ''
  if (addMode.value === 'npm' && !raw.startsWith('npm:')) return `npm:${raw}`
  if (addMode.value === 'git' && !raw.startsWith('git:') && !/^https?:/.test(raw)) return `git:${raw}`
  return raw
}

async function addPlugin() {
  const source = composedSource()
  if (!source) return
  adding.value = true
  addError.value = ''
  addNote.value = ''
  try {
    await invoke<string>('pi_pkg_install', { source })
    addNote.value = t('「{0}」已安装，重启内核后加载', [source])
    addSource.value = ''
    showAddModal.value = false
    await refreshAll()
    await restartKernel()
  } catch (e: any) {
    addError.value = String(e?.message ?? e)
  }
  adding.value = false
}

/** 托管包更新：单个透传 `pi update --extension <src>`，全部走 `pi update --extensions`。 */
async function updatePkg(source: string) {
  try {
    await invoke<string>('pi_pkg_update_one', { source })
    marketNote.value = t('「{0}」已更新，重启内核后生效', [source])
    await refreshAll()
    await restartKernel()
  } catch (e: any) {
    error.value = String(e?.message ?? e)
  }
}

async function updateAllPkgs() {
  if (!updatableCount.value) return
  try {
    await invoke<string>('pi_pkg_update_all')
    marketNote.value = t('已更新 {0} 个插件，重启内核后生效', [updatableCount.value])
    await refreshAll()
    await restartKernel()
  } catch (e: any) {
    error.value = String(e?.message ?? e)
  }
}

async function removePkg(source: string) {
  try {
    await invoke<string>('pi_pkg_remove', { source })
    marketNote.value = t('「{0}」已移除，重启内核后不再加载', [source])
    await refreshAll()
    await restartKernel()
  } catch (e: any) {
    error.value = String(e?.message ?? e)
  }
}

// ── #101 生态推荐四卡：真实 npm 包，一键 `npm:<pkg>` 透传安装 ──────────────────
interface EcoCard {
  pkg: string
  name: string
  desc: string
  version: string
}
const ECO_CARDS = computed<EcoCard[]>(() => [
  { pkg: 'pi-web-access', name: 'pi-web-access', desc: t('联网搜索、URL 抓取、GitHub 克隆、PDF 提取、YouTube 字幕'), version: '0.48.0' },
  { pkg: 'pi-subagents', name: 'pi-subagents', desc: t('单代理委派与脚本化多代理工作流'), version: '0.90.0' },
  { pkg: 'pi-mcp-adapter', name: 'pi-mcp-adapter', desc: t('读取 .mcp.json 接入 MCP 服务器'), version: '7.0.1' },
  { pkg: 'pi-plan-mode', name: 'pi-plan-mode', desc: t('只读探索 + 计划文件编辑'), version: '0.4.8' },
])
const ecoBusy = ref('')

/** 生态卡是否已装（源可能是 `npm:pkg` 或裸 `pkg`，两种都认）。 */
function ecoInstalled(pkg: string) {
  return pkgs.value.some((p) => p.source === `npm:${pkg}` || p.source === pkg)
}

async function installEco(card: EcoCard) {
  ecoBusy.value = card.pkg
  error.value = ''
  try {
    await invoke<string>('pi_pkg_install', { source: `npm:${card.pkg}` })
    marketNote.value = t('「{0}」已安装，重启内核后加载', [card.name])
    await refreshAll()
    await restartKernel()
  } catch (e: any) {
    error.value = String(e?.message ?? e)
  }
  ecoBusy.value = ''
}

onMounted(async () => {
  await Promise.all([load(), loadPkgs()])
  // 更新检测走网络，放后台不阻塞首帧。
  void checkUpdates()
})
</script>

<template>
  <section class="wd-community">
    <div class="community-hero">
      <div>
        <h1>{{ t('发现社区插件') }}</h1>
        <p>
          {{ t('已装 {0} 个扩展 · {1} 个 Pi 托管包', [installedCount, pkgs.length]) }}
          <AppButton variant="text" class="hero-link" @click="showAddModal = true">{{ t('添加插件') }}<AppIcon name="arrow-right" :size="12" />
          </AppButton>
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

        <AppButton
          variant="text"
          class="text-btn"
          :disabled="!installed.length"
          :title="t('排查扩展冲突：全部停用或恢复加载，重启内核后生效')"
          @click="setAllLoaded(loadedCount === 0)"
        >{{ loadedCount > 0 ? t('全部停用 ({0})', [loadedCount]) : t('全部恢复') }}</AppButton>

        <AppButton variant="secondary"  :title="t('复制内核与扩展诊断信息')" @click="copyDiagnostics">
          <AppIcon name="copy" :size="13" />
          <span>{{ t('诊断信息') }}</span>
        </AppButton>

        <!-- #96 DSH 顶栏：N 可更新 / 刷新 / + 添加插件 -->
        <div class="market-admin">
          <AppButton
            v-if="updatableCount"
            variant="secondary"
            class="update-chip"
            :title="t('全部更新')"
            @click="updateAllPkgs"
          >
            <AppIcon name="download" :size="13" />
            <span>{{ t('{0} 个插件可更新', [updatableCount]) }}</span>
          </AppButton>
          <AppButton
            variant="icon"
            class="admin-refresh"
            :disabled="checking"
            :title="t('刷新插件清单与更新检测')"
            :aria-label="t('刷新')"
            @click="refreshAll"
          >
            <AppIcon name="refresh" :size="14" :class="{ spinning: checking }" />
          </AppButton>
          <AppButton variant="primary" class="admin-add" @click="showAddModal = true">
            <AppIcon name="plus" :size="13" />
            <span>{{ t('添加插件') }}</span>
          </AppButton>
        </div>
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

      <!-- 发现 / 已安装：生态卡（仅发现）+ 本地扩展行 + Pi 托管包行 -->
      <div v-else class="market-body">
        <section v-if="tab === 'discover'" class="eco-section">
          <h2 class="eco-title">{{ t('Pi 生态推荐') }}</h2>
          <p class="eco-hint">{{ t('官方内核的一手扩展，一键透传安装，源与落盘由 Pi 管理。') }}</p>
          <div class="eco-grid">
            <article v-for="card in ECO_CARDS" :key="card.pkg" class="eco-card">
              <div class="eco-head">
                <strong>{{ card.name }}</strong>
                <span class="eco-ver">v{{ card.version }}</span>
              </div>
              <p class="eco-desc">{{ card.desc }}</p>
              <AppButton
                variant="primary"
                class="eco-install"
                :disabled="ecoInstalled(card.pkg) || ecoBusy === card.pkg"
                @click="installEco(card)"
              >
                {{ ecoInstalled(card.pkg) ? t('已安装') : ecoBusy === card.pkg ? t('安装中…') : t('安装') }}
              </AppButton>
            </article>
          </div>
        </section>

        <div v-if="rows.length" class="market-list">
          <article v-for="p in rows" :key="p.id" class="market-row" :class="{ unloaded: !p.loaded }">
            <div class="row-body">
              <div class="row-title">
                <strong :title="p.name">{{ p.name }}</strong>
                <span class="row-meta">
                  <i v-if="p.author && p.author !== t('未知')">@{{ p.author }}</i>
                  <i v-if="p.version && p.version !== t('未知')">{{ p.version }}</i>
                </span>
                <span v-for="(tag, idx) in p.tags" :key="idx" class="row-tag">{{ tag }}</span>
                <span v-if="!p.loaded" class="row-tag off">{{ t('已停用') }}</span>
              </div>
              <p class="row-desc" :title="p.description">{{ p.description }}</p>
              <p v-if="p.hasTools" class="row-tools" :title="t('工具：{0}', [p.tools.join('、')])">{{ t('工具：{0}', [p.tools.join('、')]) }}</p>
            </div>
            <div class="row-actions">
              <AppButton
                variant="secondary"
                class="row-load"
                :class="{ off: !p.loaded }"
                :title="p.loaded ? t('停用扩展（重启内核后不再加载）') : t('加载扩展（重启内核后生效）')"
                @click="setExtensionLoaded(p, !p.loaded)"
              >{{ p.loaded ? t('已加载') : t('加载') }}</AppButton>
              <AppButton
                variant="secondary"
                class="row-remove"
                :disabled="!p.removable"
                :title="p.removable ? t('删除该扩展文件') : t('内置扩展不能删除，只能停用')"
                @click="removeExtension(p)"
              >
                <AppIcon name="close" :size="12" />
              </AppButton>
              <AppButton
                variant="secondary"
                class="row-install"
                :class="{ installed: p.enabled }"
                :disabled="!p.hasTools || !p.loaded"
                :title="
                  !p.loaded
                    ? t('扩展已停用')
                    : p.hasTools
                      ? p.enabled
                        ? t('从内核默认工具里移除')
                        : t('把工具写进内核默认工具')
                      : t('该扩展不提供工具')
                "
                @click="setExtensionEnabled(p.tools, !p.enabled, p.name)"
              >
                {{ !p.hasTools ? t('无工具') : p.enabled ? t('已启用') : t('启用') }}
              </AppButton>
            </div>
          </article>
        </div>

        <!-- Pi 托管包（npm / git / 本地目录），与本地扩展并列 -->
        <div v-if="managedRows.length" class="market-list pkg-list">
          <article v-for="p in managedRows" :key="p.source" class="market-row pkg-row">
            <div class="row-body">
              <div class="row-title">
                <strong class="row-source" :title="p.source">{{ p.source }}</strong>
                <span class="row-tag">{{ p.scope }}</span>
                <span v-if="p.update" class="row-tag off">{{ t('可更新') }}</span>
              </div>
              <p class="row-desc" :title="p.installed_path">{{ p.installed_path }}</p>
              <p v-if="p.update" class="row-tools">{{ t('当前 {0} → 最新 {1}', [p.update.current, p.update.latest]) }}</p>
            </div>
            <div class="row-actions">
              <AppButton
                v-if="p.update"
                variant="secondary"
                class="row-load"
                :title="t('更新至 {0}', [p.update.latest])"
                @click="updatePkg(p.source)"
              >{{ t('更新') }}</AppButton>
              <AppButton
                variant="secondary"
                class="row-remove"
                :title="t('移除该托管包')"
                @click="removePkg(p.source)"
              >
                <AppIcon name="close" :size="12" />
              </AppButton>
            </div>
          </article>
        </div>

        <div v-if="!rows.length && !managedRows.length" class="empty-state">
          <p class="empty-title">{{ keyword ? t('没有匹配的插件') : t('暂无插件') }}</p>
          <p class="empty-hint">{{ keyword ? t('保留搜索词，可清除后重试。') : t('点顶栏「添加插件」安装 Pi 托管包。') }}</p>
        </div>
      </div>

    <!-- #96 DSH 形态「添加插件」弹窗：任意源 + 引导折叠 + 可信警告 + 安装钮 -->
    <AppModal :open="showAddModal" :title="t('添加插件')" size="md" @close="showAddModal = false">
      <p class="modal-desc">{{ t('输入包名、GitHub 仓库或本地目录路径，透传给 Pi 安装；源语法与落盘位置由 Pi 决定。') }}</p>
      <div class="add-row">
        <AppSelect v-model="addMode" :options="ADD_MODE_OPTIONS" class="add-mode" width="128px" />
        <AppInput
          v-model="addSource"
          class="add-source"
          :placeholder="t('包名 / GitHub 仓库 / 本地目录路径')"
          @keyup.enter="addPlugin"
        />
      </div>

      <button
        type="button"
        class="guide-toggle"
        :aria-expanded="addGuide"
        @click="addGuide = !addGuide"
      >
        <AppIcon name="chevron-right" :size="13" :class="{ rotated: addGuide }" />
        {{ t('插件安装引导和示例') }}
      </button>
      <div v-if="addGuide" class="guide-body">
        <p><code>npm:</code>{{ t('npm 包名，可钉住版本') }}</p>
        <p><code>git:</code>{{ t('Git 仓库，如 github.com/user/repo；也可直接粘贴 https 链接') }}</p>
        <p><code>./</code>{{ t('本机目录路径，相对或绝对，Pi 原样加载') }}</p>
      </div>

      <p class="trust-bar">
        <AppIcon name="alert-triangle" :size="14" />
        {{ t('扩展以内核权限运行，安装前请确认来源可信。') }}
      </p>

      <p v-if="addError" class="state-error" role="alert">{{ addError }}</p>
      <p v-if="addNote" class="market-note" role="status">{{ addNote }}</p>
      <template #footer>
        <AppButton
          variant="primary"
          class="add-submit"
          :disabled="!composedSource() || adding"
          @click="addPlugin"
        >
          {{ adding ? t('安装中…') : t('安装') }}
        </AppButton>
      </template>
    </AppModal>

    <!-- 旧 .ts 直链弹窗（保留 Workbench 原生活通道） -->
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
