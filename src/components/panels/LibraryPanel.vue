<script setup lang="ts">
import { t } from '@/i18n'
/**
 * 资料库 —— 面板版式与功能。
 *
 * 四个 tab 全部接后端，不再有「版式占位」：
 *   · 资料库：目录树 + 正文预览编辑，支持新建 / 导入 / 重命名 / 移动 / 删除 / 停用 / 发布 / 回滚；
 *   · 搜索：后端检索，命中带目录、类型、来源、修订、转换状态与段号位置；
 *   · 最近 / 输出：后端持久化的「最近打开 / 最近写入」，不是 localStorage。
 */
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { onTablistKeydown } from '@/composables/useTablist'
import { open } from '@tauri-apps/plugin-dialog'
import {
  convertStatusText,
  kindText,
  originText,
  describeLibraryError,
  formatBytes,
  formatTime,
  libraryArchiveDismiss,
  libraryArchiveFailures,
  libraryArchiveRetry,
  libraryCreate,
  libraryImport,
  libraryList,
  libraryMarks,
  libraryMove,
  libraryOpen,
  libraryBytes,
  libraryPublish,
  libraryRead,
  libraryRemove,
  libraryRevisions,
  libraryRollback,
  librarySearch,
  librarySetEnabled,
  libraryStats,
  libraryTree,
  libraryWrite,
  libraryRename,
  type ArchiveFailure,
  type LibraryAssetView,
  type LibraryHit,
  type LibraryNode,
  type LibraryRevision,
  type LibraryStats,
} from '@/composables/useLibrary'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppTextarea from '@/components/ui/AppTextarea.vue'
import MemoryView from '@/views/MemoryView.vue'
import { officeToHtml } from '@/composables/useOfficePreview'
import { sanitizeHtml } from '@/utils/sanitizeHtml'
import type { ArtifactKind } from '@/composables/useArtifacts'

type View = 'library' | 'search' | 'recent' | 'outputs' | 'memory'
type Dialog = '' | 'create' | 'rename' | 'move' | 'import' | 'revisions'

const views = computed<{ key: View; label: string; icon: string }[]>(() => [
  { key: 'library', label: t('资料库'), icon: 'book' },
  { key: 'search', label: t('搜索'), icon: 'search' },
  { key: 'recent', label: t('最近'), icon: 'clock' },
  { key: 'outputs', label: t('输出'), icon: 'box' },
  { key: 'memory', label: t('记忆'), icon: 'database' },
])

const route = useRoute()

/** 记忆层并入资料库：/library?view=memory 直接落到「记忆」tab。 */
const VIEW_KEYS: View[] = ['library', 'search', 'recent', 'outputs', 'memory']
function viewFromQuery(): View {
  const q = route.query.view
  const value = Array.isArray(q) ? q[0] : q
  return VIEW_KEYS.includes(value as View) ? (value as View) : 'library'
}

/** 全局搜索带过来的查询词：/library?view=search&q=... 直接落到搜索页。 */
function queryText(key: string): string {
  const raw = route.query[key]
  const value = Array.isArray(raw) ? raw[0] : raw
  return typeof value === 'string' ? value : ''
}

const view = ref<View>(viewFromQuery())
const busy = ref(true)
const status = ref('')
const stats = ref<LibraryStats | null>(null)
const assets = ref<LibraryAssetView[]>([])
const marks = ref<LibraryAssetView[]>([])
/** 自动归档失败的批次：列表来自后端，刷新页面后仍在。 */
const archiveFailures = ref<ArchiveFailure[]>([])
const children = ref<Record<string, LibraryNode[]>>({})
const expanded = ref<Set<string>>(new Set())
const cwd = ref('/')
const keyword = ref(queryText('q'))
const hits = ref<LibraryHit[]>([])
const selectedId = ref('')
const content = ref('')
const dirty = ref(false)

const dialog = ref<Dialog>('')
const dialogName = ref('')
const dialogDir = ref('')
const confirmDelete = ref(false)
const revisions = ref<LibraryRevision[]>([])

const selected = computed<LibraryAssetView | null>(
  () => assets.value.find((a) => a.id === selectedId.value) ?? null,
)
const selectedPath = computed(() => {
  const p = (selected.value?.rel_path ?? '').split('/')
  return p.slice(0, -1).join('/') || '/'
})
const usedRatio = computed(() => {
  const s = stats.value
  if (!s || !s.max_total_bytes) return 0
  return Math.min(1, s.used_bytes / s.max_total_bytes)
})
const convertText = (a: LibraryAssetView) =>
  !a.enabled ? convertStatusText('skipped') : a.searchable ? convertStatusText('ready') : convertStatusText('failed')

async function refresh() {
  busy.value = true
  try {
    const [list, stat, mark, failures] = await Promise.all([
      libraryList(),
      libraryStats(),
      libraryMarks(view.value === 'outputs' ? 'written' : 'recent'),
      // 失败批次是附加信息：读不到不该让整个资料库报错。
      libraryArchiveFailures().catch(() => [] as ArchiveFailure[]),
    ])
    assets.value = list
    stats.value = stat
    marks.value = mark
    // 预览/旧内核可能返回 null，模板里要读 length，先归一成数组。
    archiveFailures.value = Array.isArray(failures) ? failures : []
    if (!list.some((a) => a.id === selectedId.value)) selectedId.value = ''
  } catch (e) {
    status.value = describeLibraryError(e)
  }
  busy.value = false
  // 「刷新」的语义是把磁盘变化拉回来；只刷资产表不刷树等于没刷新。
  const dirs = new Set<string>(['/', ...expanded.value])
  if (cwd.value) dirs.add(cwd.value)
  await Promise.all([...dirs].map((d) => loadTree(d)))
}

async function loadTree(dir: string) {
  try {
    children.value = { ...children.value, [dir]: await libraryTree(dir) }
  } catch (e) {
    status.value = describeLibraryError(e)
  }
}

function rowsOf(dir: string): LibraryNode[] {
  return children.value[dir] ?? []
}

async function toggleDir(node: LibraryNode) {
  if (!node.is_dir) return
  if (expanded.value.has(node.path)) {
    expanded.value.delete(node.path)
    return
  }
  expanded.value.add(node.path)
  cwd.value = node.path
  await loadTree(node.path)
}

async function openNode(node: LibraryNode) {
  if (node.is_dir) {
    await toggleDir(node)
    return
  }
  const id = node.asset_id
  // 未登记文件已在树里过滤掉；这里只做类型兜底，不再给出做不到的指引。
  if (!id) return
  await openAsset(id)
}

const officeHtml = ref('')

function isOfficeAsset(a: LibraryAssetView | null): boolean {
  if (!a) return false
  // 只承诺真正实现了解析器的两种：docx（docx-preview）与 xlsx（SheetJS）。
  // pdf/pptx 交给「原件」，不再先读 12 MiB 字节再失败。
  const name = a.name.toLowerCase()
  return a.kind === 'docx' || name.endsWith('.xlsx')
}

async function loadPreview(id: string) {
  officeHtml.value = ''
  // 读取失败/停用时必须清空，否则会把上一个文件的正文留在当前文件名下。
  content.value = ''
  const a = assets.value.find((x) => x.id === id) ?? null
  if (a && isOfficeAsset(a)) {
    try {
      const res = await libraryBytes(id)
      officeHtml.value = sanitizeHtml(await officeToHtml(res.kind as ArtifactKind, res.content))
    } catch (e) {
      officeHtml.value = ''
      status.value = describeLibraryError(e, t('无法预览该文件，请用「原件」打开'))
    }
    return
  }
  const body = await libraryRead(id)
  content.value = body.content
  status.value = body.truncated ? t('正文超过 512 KiB，已截断显示') : ''
}

async function openAsset(id: string) {
  selectedId.value = id
  dirty.value = false
  try {
    await loadPreview(id)
  } catch (e) {
    status.value = describeLibraryError(e)
  }
  await refresh()
}

async function save() {
  const id = selectedId.value
  if (!id) return
  try {
    await libraryWrite(id, content.value)
    dirty.value = false
    status.value = ''
  } catch (e) {
    status.value = describeLibraryError(e)
  }
  await refresh()
}

async function publish() {
  const id = selectedId.value
  if (!id) return
  try {
    await libraryPublish(id)
    status.value = t('已发布：现在可以被检索到')
  } catch (e) {
    status.value = describeLibraryError(e)
  }
  await refresh()
}

async function toggleEnabled() {
  const id = selectedId.value
  if (!id) return
  try {
    await librarySetEnabled(id, !selected.value?.enabled)
    status.value = ''
  } catch (e) {
    status.value = describeLibraryError(e)
  }
  await refresh()
}

async function removeAsset() {
  const id = selectedId.value
  if (!id) return
  // selectedPath 依赖 selected，清空 selectedId 之后就退回根目录了，必须先记下来。
  const dir = selectedPath.value
  try {
    await libraryRemove(id)
    selectedId.value = ''
    content.value = ''
    confirmDelete.value = false
    status.value = t('已删除原件、索引与修订快照')
  } catch (e) {
    status.value = describeLibraryError(e)
  }
  await refresh()
  await loadTree(dir)
}

/** 重试所有失败批次；成功的批次后端会自行移除。 */
async function retryArchives() {
  let imported = 0
  for (const batch of [...archiveFailures.value]) {
    try {
      imported += (await libraryArchiveRetry(batch.id)).imported
    } catch {
      // 单批失败保留在列表里，继续下一批。
    }
  }
  status.value = imported
    ? t('已补归档 {0} 个文件', [imported])
    : t('仍然归档失败，请确认源文件还在')
  await refresh()
}

async function dismissArchives() {
  for (const batch of [...archiveFailures.value]) {
    await libraryArchiveDismiss(batch.id).catch(() => undefined)
  }
  await refresh()
}

async function runSearch() {
  const q = keyword.value.trim()
  if (!q) {
    hits.value = []
    return
  }
  try {
    hits.value = await librarySearch(q)
  } catch (e) {
    status.value = describeLibraryError(e)
  }
}

function openHit(hit: LibraryHit) {
  selectedId.value = hit.asset_id
  view.value = 'library'
}

async function openOriginal() {
  const id = selectedId.value
  if (!id) return
  try {
    await libraryOpen(id)
  } catch (e) {
    status.value = describeLibraryError(e)
  }
}

async function openRevisions() {
  const id = selectedId.value
  if (!id) return
  try {
    revisions.value = await libraryRevisions(id)
    dialog.value = 'revisions'
  } catch (e) {
    status.value = describeLibraryError(e)
  }
}

async function rollback(rev: number) {
  try {
    await libraryRollback(selectedId.value, rev)
    status.value = t('已回滚到 #{0}', [rev])
    dialog.value = ''
  } catch (e) {
    status.value = describeLibraryError(e)
  }
  await refresh()
}

/** 打开弹窗一律走方法：模板里对 ref 做赋值既不好读，也让 vue-tsc 无从校验。 */
function openCreate() {
  dialogName.value = ''
  dialog.value = 'create'
}

function openRename() {
  dialogName.value = selected.value?.name ?? ''
  dialog.value = 'rename'
}

function openMove() {
  dialogDir.value = selectedPath.value
  dialog.value = 'move'
}

function openImport() {
  // 不清空的话，第二次打开会带着上次的源路径，直接撞「目标位置已存在同名文件」。
  dialogName.value = ''
  dialog.value = 'import'
}

async function submitCreate() {
  const name = dialogName.value.trim()
  if (!name) {
    status.value = describeLibraryError(null, t('请填写文件名'))
    return
  }
  try {
    // 新建即草稿：不发布就不进检索，这是草稿发布流程的起点。
    const asset = await libraryCreate(cwd.value, name, '')
    dialog.value = ''
    dialogName.value = ''
    selectedId.value = asset.id
    status.value = t('已新建草稿，写正文后点「发布」才会进入检索')
  } catch (e) {
    status.value = describeLibraryError(e)
  }
  expanded.value.add(cwd.value)
  await refresh()
  await loadTree(cwd.value)
}

async function submitRename() {
  const id = selectedId.value
  const name = dialogName.value.trim()
  if (!id) return
  if (!name) {
    status.value = describeLibraryError(null, t('请填写新名称'))
    return
  }
  try {
    await libraryRename(id, name)
    dialog.value = ''
    status.value = ''
  } catch (e) {
    status.value = describeLibraryError(e)
  }
  await refresh()
  await loadTree(selectedPath.value)
}

async function submitMove() {
  const id = selectedId.value
  if (!id) return
  try {
    await libraryMove(id, dialogDir.value.trim() || '/')
    dialog.value = ''
    status.value = ''
  } catch (e) {
    status.value = describeLibraryError(e)
  }
  await refresh()
  await loadTree(selectedPath.value)
}

/** 文件选择器在浏览器环境（vitest / 开发预览）不可用，失败就回退到手动填路径。 */
async function submitImport() {
  let path = dialogName.value.trim()
  if (!path) {
    try {
      const picked = await open({ multiple: false })
      if (typeof picked === 'string' && picked) path = picked
    } catch {
      path = ''
    }
  }
  if (!path) return
  try {
    // 后端按内容哈希去重：命中已有记录时返回的是旧条目，界面要说清「没新增」。
    const before = new Set(assets.value.map((a) => a.id))
    const view = await libraryImport(path, cwd.value)
    dialog.value = ''
    expanded.value.add(cwd.value)
    status.value = before.has(view.id)
      ? t('资料库里已有相同内容的文件：{0}', [view.rel_path])
      : t('已导入原件，转换器结果见转换状态')
  } catch (e) {
    status.value = describeLibraryError(e, t('导入失败：{0}', [String(e)]))
  }
  await refresh()
  await loadTree(cwd.value)
}

function fileIcon(node: LibraryNode) {
  if (node.is_dir) return expanded.value.has(node.path) ? 'folder-open' : 'folder'
  const a = assets.value.find((x) => x.id === node.asset_id)
  switch (a?.kind) {
    case 'pdf':
      return 'pdf'
    case 'markdown':
    case 'text':
      return 'file'
    case 'html':
      return 'code'
    case 'docx':
      return 'doc'
    case 'pptx':
      return 'slide'
    case 'other':
      return 'table'
    default:
      return 'doc'
  }
}

function renderTree(dir: string, depth = 0): { node: LibraryNode; depth: number }[] {
  const out: { node: LibraryNode; depth: number }[] = []
  for (const node of rowsOf(dir)) {
    // 磁盘上没有登记为资料的文件点开没有任何可用操作，展示出来就是死入口。
    if (!node.is_dir && !node.asset_id) continue
    out.push({ node, depth })
    if (node.is_dir && expanded.value.has(node.path)) {
      out.push(...renderTree(node.path, depth + 1))
    }
  }
  return out
}

watch(
  () => [view.value, keyword.value],
  async () => {
    if (view.value === 'search' && keyword.value.trim()) await runSearch()
    if (view.value !== 'library') {
      try {
        marks.value = await libraryMarks(view.value === 'outputs' ? 'written' : 'recent')
      } catch (e) {
        status.value = describeLibraryError(e)
      }
    }
  },
)

watch(selectedId, async (id) => {
  dirty.value = false
  if (!id) return
  try {
    await loadPreview(id)
  } catch (e) {
    status.value = describeLibraryError(e)
  }
})

watch(
  view,
  (v) => {
    confirmDelete.value = false
    if (v === 'library') loadTree(cwd.value)
  },
  { immediate: true },
)

// 兼容来自 /agent-ops/memory 的重定向与全局搜索的 ?q=：
// query 变化时同步 tab 与搜索词（同路径改 query 不会重挂载本组件）。
watch(
  () => [route.query.view, route.query.q],
  ([v, q]) => {
    const value = Array.isArray(v) ? v[0] : v
    if (value && VIEW_KEYS.includes(value as View)) view.value = value as View
    const text = Array.isArray(q) ? q[0] : q
    if (typeof text === 'string' && text) keyword.value = text
  },
)

refresh()
// 带 ?view=search&q= 直接进入时不会触发上面的 watch，必须在这里补一次检索。
if (view.value === 'search' && keyword.value.trim()) runSearch()
</script>

<template>
  <section class="wd-library">
    <header class="lib-header">
      <div class="lib-title">
        <h1>{{ t('资料库') }}</h1>
        <p v-if="view !== 'memory'" class="muted">{{ t('浏览、检索并维护项目内的文件资产。原件始终保留，检索文本只是产物。') }}</p>
      </div>
      <div v-if="stats" class="lib-quota">
        <span class="quota-text">
          {{ t('{0} 份 · {1} / {2}', [stats.asset_count, formatBytes(stats.used_bytes), formatBytes(stats.max_total_bytes)]) }}
        </span>
        <div class="quota-bar" role="img" :aria-label="t('已用 {0}', [formatBytes(stats.used_bytes)])">
          <!-- 功能性动态值（配额比例），豁免纯样式抽离铁律：CSS 变量传值 -->
          <span :style="{ '--quota-w': `${usedRatio * 100}%` }"></span>
        </div>
      </div>
    </header>

    <div class="lib-toolbar">
      <nav class="lib-tabs" role="tablist" :aria-label="t('资料库视图')" @keydown="onTablistKeydown">
        <AppButton
          v-for="v in views"
          :key="v.key"
          variant="tab"
          role="tab"
          :aria-selected="view === v.key"
          :tabindex="view === v.key ? 0 : -1"
          class="lib-tab"
          :class="{ active: view === v.key }"
          @click="view = v.key"
        >
          <AppIcon :name="v.icon" :size="14" />
          {{ v.label }}
        </AppButton>
      </nav>
      <div class="lib-tools">
        <!-- 记忆 tab 的检索由记忆层自己负责，这里的资料库检索框不适用。 -->
        <AppInput
          v-if="view === 'search'"
          v-model="keyword"
          :placeholder="t('搜索资料库全文')"
        />
        <AppButton
          v-if="view === 'library'"
          variant="secondary"
          :title="t('在当前目录下新建草稿')"
          @click="openCreate()"
        >
          <AppIcon name="folder-plus" :size="14" />{{ t('新建') }}</AppButton>
        <AppButton
          v-if="view === 'library'"
          variant="secondary"
          :title="t('导入外部文件')"
          @click="openImport()"
        >
          <AppIcon name="upload" :size="14" />{{ t('导入') }}</AppButton>
        <AppButton variant="icon"  :title="t('刷新')" :aria-label="t('刷新资料库')" :disabled="busy" @click="refresh()">
          <AppIcon name="refresh" :size="14" />
        </AppButton>
      </div>
    </div>

    <!-- 记忆 tab 下资料库自身的加载错误与本页无关，交给内嵌的记忆视图表达状态。 -->
    <div
      v-if="archiveFailures.length && view !== 'memory'"
      class="lib-status err lib-archive-fail"
      role="alert">
      <span>{{ t('有 {0} 批自动归档失败，源文件与原件都还在', [archiveFailures.length]) }}</span>
      <AppButton variant="text" @click="retryArchives()">{{ t('重试') }}</AppButton>
      <AppButton variant="text" @click="dismissArchives()">{{ t('忽略') }}</AppButton>
    </div>
    <div v-if="status && view !== 'memory'" class="lib-status err" role="alert">{{ status }}</div>
    <div v-if="busy && view !== 'memory'" class="load-state">{{ t('正在加载资料库…') }}</div>

    <section v-if="view === 'memory'" class="lib-memory-shell">
      <MemoryView embedded />
    </section>

    <div v-else class="lib-body">
      <aside v-if="view === 'search'" class="lib-tree">
        <div class="tree-head"><span class="muted">{{ t('命中结果') }}</span></div>
        <ul class="tree-list">
          <li
            v-for="hit in hits"
            :key="`${hit.asset_id}-${hit.location ?? 'name'}`"
            class="hit-node"
            @click="openHit(hit)"
          >
            <div class="hit-top">
              <AppIcon name="search" :size="12" />
              <span class="tree-name" :title="hit.name">{{ hit.name }}</span>
              <span class="hit-convert" :class="{ bad: hit.convert_status !== 'ready' }">
                {{ convertStatusText(hit.convert_status) }}
              </span>
            </div>
            <div class="hit-meta">
              <span>{{ t('目录 {0}', [hit.dir]) }}</span>
              <span>{{ kindText(hit.kind) }}</span>
              <span :title="hit.origin.detail">
                {{ t('来源 {0}', [hit.origin.kind === 'auto-archive' ? `${originText(hit.origin.kind)} · ${hit.origin.detail}` : originText(hit.origin.kind)]) }}
              </span>
              <span>{{ t('修订 #{0}', [hit.revision]) }}</span>
              <span v-if="hit.location">{{ hit.location }}</span>
            </div>
            <p class="hit-snippet">{{ hit.snippet }}</p>
          </li>
          <li v-if="!hits.length" class="tree-empty">
            {{ keyword.trim() ? t('没有命中，换个关键词试试') : t('输入关键词做全文检索') }}
          </li>
        </ul>
      </aside>

      <aside v-else-if="view === 'recent' || view === 'outputs'" class="lib-tree">
        <div class="tree-head">
          <span class="muted">{{ view === 'outputs' ? t('最近写入') : t('最近打开') }}</span>
        </div>
        <ul class="tree-list">
          <li
            v-for="m in marks"
            :key="m.id"
            class="tree-node"
            :class="{ active: m.id === selectedId }"
            @click="openAsset(m.id)"
          >
            <AppIcon name="clock" :size="14" />
            <span class="tree-name" :title="m.name">{{ m.name }}</span>
            <span class="tree-badge">{{ m.dir }}</span>
          </li>
          <li v-if="!marks.length" class="tree-empty">{{ t('还没有记录') }}</li>
        </ul>
      </aside>

      <aside v-else class="lib-tree">
        <div class="tree-head"><span class="muted">{{ t('目录') }}</span></div>
        <ul class="tree-list">
          <li
            v-for="item in renderTree('/')"
            :key="item.node.path"
            class="tree-node"
            :class="{ active: item.node.asset_id && item.node.asset_id === selectedId, dir: item.node.is_dir }"
            :style="{ '--tree-indent': `${12 + item.depth * 16}px` }"
            @click="openNode(item.node)"
          >
            <AppIcon :name="fileIcon(item.node)" :size="14" />
            <span class="tree-name" :title="item.node.name">{{ item.node.name }}</span>
            <span
              v-if="item.node.asset_id && assets.find((a) => a.id === item.node.asset_id)?.draft"
              class="tree-flag"
            >{{ t('草稿') }}</span>
            <span
              v-else-if="
                item.node.asset_id &&
                assets.find((a) => a.id === item.node.asset_id) &&
                !assets.find((a) => a.id === item.node.asset_id)?.enabled
              "
              class="tree-flag off"
            >{{ t('停用') }}</span>
          </li>
          <li v-if="!rowsOf('/').length" class="tree-empty">{{ t('还没有文件，先新建一个草稿') }}</li>
        </ul>
      </aside>

      <section v-if="selected" class="lib-preview">
        <div class="preview-head">
          <div class="preview-title">
            <AppIcon name="file" :size="14" /> {{ selected.name }}
            <span v-if="selected.draft" class="preview-flag">{{ t('草稿') }}</span>
            <span v-if="dirty" class="preview-dirty">{{ t('未保存') }}</span>
          </div>
          <div class="preview-actions">
            <!-- 动作分级：保存是主动作（primary），删除是危险动作，其余维护动作收成文字按钮。
                 八个同权描边胶囊并排时，眼睛无法判断先点哪个。 -->
            <AppButton variant="primary" :disabled="!dirty" @click="save()">
              <AppIcon name="check" :size="14" />{{ t('保存') }}</AppButton>
            <AppButton variant="text" :title="t('重命名')" @click="openRename()">
              <AppIcon name="edit" :size="14" />{{ t('重命名') }}</AppButton>
            <AppButton variant="text" :title="t('移动到其它目录')" @click="openMove()">
              <AppIcon name="corner-down-left" :size="14" />{{ t('移动') }}</AppButton>
            <AppButton
              v-if="selected.draft"
              variant="text"
              :disabled="!selected.enabled"
              :title="selected.enabled ? t('发布') : t('停用状态下发布也不会进入检索')"
              @click="publish()">
              <AppIcon name="upload" :size="14" />{{ t('发布') }}</AppButton>
            <AppButton variant="text" @click="toggleEnabled()">
              <AppIcon name="lock" :size="14" /> {{ selected.enabled ? t('停用') : t('启用') }}
            </AppButton>
            <AppButton variant="text" :title="t('查看修订并回滚')" @click="openRevisions()">
              <AppIcon name="corner-down-left" :size="14" />{{ t('修订') }}</AppButton>
            <AppButton variant="text" @click="openOriginal()">
              <AppIcon name="external" :size="14" />{{ t('原件') }}</AppButton>
            <AppButton variant="danger" :title="t('删除资料')" @click="confirmDelete = true">
              <AppIcon name="trash" :size="14" />{{ t('删除') }}</AppButton>
          </div>
        </div>

        <div class="preview-meta">
          <span>{{ t('目录 {0}', [selected.dir]) }}</span>
          <span>{{ kindText(selected.kind) }}</span>
          <span>{{ t('来源 {0}{1}', [originText(selected.origin.kind), selected.origin.detail ? ` · ${selected.origin.detail}` : '']) }}</span>
          <span>{{ t('修订 #{0}', [selected.revision]) }}</span>
          <span>{{ formatBytes(selected.size) }}</span>
          <span :class="{ 'meta-bad': !selected.searchable }">{{ t('转换 {0}', [convertText(selected)]) }}
          </span>
          <span class="muted">{{ formatTime(selected.updated_at) }}</span>
        </div>
        <div v-if="selected.convert_error && !selected.searchable" class="preview-note">{{ t('转换失败原因：{0}（原件未改动）', [selected.convert_error]) }}</div>

        <AppTextarea
          v-if="selected.kind === 'markdown' || selected.kind === 'text' || selected.kind === 'html'"
          v-model="content"
          class="preview-editor"
          mono
          @update:model-value="dirty = true"
        />
        <div v-else-if="officeHtml" class="preview-office">
          <p class="preview-office-caveat">{{ t('只读预览：还原阅读版式，不承诺与 Office 逐项保真') }}</p>
          <div class="office-body" v-html="officeHtml"></div>
        </div>
        <div v-else class="preview-binary">
          <AppIcon name="pdf" :size="28" />
          <span>{{ t('该格式不在正文通道内，点「原件」用系统应用打开。') }}</span>
        </div>
      </section>
    </div>

    <AppModal :open="dialog === 'create'" :title="t('新建草稿')" size="sm" @close="dialog = ''">
      <label class="dialog-row">
        <span>{{ t('文件名') }}</span>
        <AppInput v-model="dialogName" :placeholder="t('例如 会议纪要.md')" />
      </label>
      <p class="dialog-hint">{{ t('当前目录：{0}', [cwd]) }}</p>
      <template #footer>
        <AppButton variant="secondary" @click="dialog = ''">{{ t('取消') }}</AppButton>
        <AppButton variant="primary" @click="submitCreate()">{{ t('新建') }}</AppButton>
      </template>
    </AppModal>

    <AppModal :open="dialog === 'rename'" :title="t('重命名')" size="sm" @close="dialog = ''">
      <label class="dialog-row">
        <span>{{ t('新名称') }}</span>
        <AppInput v-model="dialogName" :placeholder="selected?.name ?? ''" />
      </label>
      <template #footer>
        <AppButton variant="secondary" @click="dialog = ''">{{ t('取消') }}</AppButton>
        <AppButton variant="primary" @click="submitRename()">{{ t('保存') }}</AppButton>
      </template>
    </AppModal>

    <AppModal :open="dialog === 'move'" :title="t('移动到…')" size="sm" @close="dialog = ''">
      <label class="dialog-row">
        <span>{{ t('目标目录') }}</span>
        <AppInput v-model="dialogDir" placeholder="/docs" />
      </label>
      <p class="dialog-hint">{{ t('填相对资料库根目录的目录，根级填 /；文件本身留在原来的名字。') }}</p>
      <template #footer>
        <AppButton variant="secondary" @click="dialog = ''">{{ t('取消') }}</AppButton>
        <AppButton variant="primary" @click="submitMove()">{{ t('移动') }}</AppButton>
      </template>
    </AppModal>

    <AppModal :open="dialog === 'import'" :title="t('导入文件')" size="sm" @close="dialog = ''">
      <label class="dialog-row">
        <span>{{ t('源文件路径') }}</span>
        <AppInput v-model="dialogName" :placeholder="t('留空则点按钮选择文件')" />
      </label>
      <p class="dialog-hint">{{ t('当前目录：{0}。原件复制进资料库后保留原文件名。', [cwd]) }}</p>
      <template #footer>
        <AppButton variant="secondary" @click="dialog = ''">{{ t('取消') }}</AppButton>
        <AppButton variant="primary" @click="submitImport()">{{ t('导入') }}</AppButton>
      </template>
    </AppModal>

    <AppModal :open="dialog === 'revisions'" :title="t('修订历史')" size="sm" @close="dialog = ''">
      <ul class="rev-list">
        <li v-for="r in revisions" :key="r.rev">
          <span class="rev-no">#{{ r.rev }}</span>
          <span class="rev-size">{{ formatBytes(r.size) }}</span>
          <span class="muted">{{ formatTime(r.at) }}</span>
          <AppButton variant="text" size="sm" class="tiny" @click="rollback(r.rev)">{{ t('回滚到此版') }}</AppButton>
        </li>
      </ul>
      <p v-if="!revisions.length" class="dialog-hint">{{ t('还没有修订快照，保存正文后会自动生成。') }}</p>
      <template #footer>
        <AppButton variant="secondary" @click="dialog = ''">{{ t('关闭') }}</AppButton>
      </template>
    </AppModal>

    <AppModal
      :open="confirmDelete"
      :title="t('删除资料')"
      size="sm"
      @close="confirmDelete = false"
    >
      <p>{{ t('删除「{0}」会同时删掉索引与全部修订快照，原件不可恢复。', [selected?.name]) }}</p>
      <template #footer>
        <AppButton variant="secondary" @click="confirmDelete = false">{{ t('取消') }}</AppButton>
        <AppButton variant="danger" @click="removeAsset()">{{ t('确认删除') }}</AppButton>
      </template>
    </AppModal>
  </section>
</template>

<style src="./LibraryPanel.css" scoped></style>
