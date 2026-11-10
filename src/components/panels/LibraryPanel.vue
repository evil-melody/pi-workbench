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
  a.searchable ? convertStatusText('ready') : convertStatusText(a.enabled ? 'failed' : 'skipped')

async function refresh() {
  busy.value = true
  try {
    const [list, stat, mark] = await Promise.all([
      libraryList(),
      libraryStats(),
      libraryMarks(view.value === 'outputs' ? 'written' : 'recent'),
    ])
    assets.value = list
    stats.value = stat
    marks.value = mark
    if (!list.some((a) => a.id === selectedId.value)) selectedId.value = ''
  } catch (e) {
    status.value = describeLibraryError(e)
  }
  busy.value = false
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
  if (!id) {
    status.value = t('磁盘上有这个文件，但还没登记为资料；先在目录里选中它再操作。')
    return
  }
  await openAsset(id)
}

const officeHtml = ref('')

function isOfficeAsset(a: LibraryAssetView | null): boolean {
  if (!a) return false
  const name = a.name.toLowerCase()
  return a.kind === 'docx' || a.kind === 'pptx' || a.kind === 'pdf' || name.endsWith('.xlsx')
}

async function loadPreview(id: string) {
  officeHtml.value = ''
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
  try {
    await libraryRemove(id)
    selectedId.value = ''
    confirmDelete.value = false
    status.value = t('已删除原件、索引与修订快照')
  } catch (e) {
    status.value = describeLibraryError(e)
  }
  await refresh()
  await loadTree(selectedPath.value)
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
    await libraryImport(path, cwd.value)
    dialog.value = ''
    expanded.value.add(cwd.value)
    status.value = t('已导入原件，转换器结果见转换状态')
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
loadTree('/')
</script>

<template>
  <section class="wd-library">
    <header class="lib-header">
      <div class="lib-title">
        <h1>{{ t('资料库') }}</h1>
        <p class="muted">{{ t('浏览、检索并维护项目内的文件资产。原件始终保留，检索文本只是产物。') }}</p>
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
          v-if="view !== 'memory'"
          v-model="keyword"
          :placeholder="view === 'library' ? t('在当前目录下筛选') : t('搜索资料库全文')"
        />
        <AppButton
          v-if="view === 'library'"
          variant="secondary"
          class="tool-btn"
          :title="t('在当前目录下新建草稿')"
          @click="openCreate()"
        >
          <AppIcon name="folder-plus" :size="14" />{{ t('新建') }}</AppButton>
        <AppButton
          v-if="view === 'library'"
          variant="secondary"
          class="tool-btn"
          :title="t('导入外部文件')"
          @click="dialog = 'import'"
        >
          <AppIcon name="upload" :size="14" />{{ t('导入') }}</AppButton>
        <AppButton variant="icon" class="tool-btn" :title="t('刷新')" :aria-label="t('刷新资料库')" :disabled="busy" @click="refresh()">
          <AppIcon name="refresh" :size="14" />
        </AppButton>
      </div>
    </div>

    <!-- 记忆 tab 下资料库自身的加载错误与本页无关，交给内嵌的记忆视图表达状态。 -->
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
              <span>{{ t('来源 {0}', [originText(hit.origin.kind)]) }}</span>
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
            <AppButton variant="secondary" class="tool-btn" :disabled="!dirty" @click="save()">
              <AppIcon name="check" :size="14" />{{ t('保存') }}</AppButton>
            <AppButton variant="secondary" class="tool-btn" :title="t('重命名')" @click="openRename()">
              <AppIcon name="edit" :size="14" />{{ t('重命名') }}</AppButton>
            <AppButton variant="secondary" class="tool-btn" :title="t('移动到其它目录')" @click="openMove()">
              <AppIcon name="corner-down-left" :size="14" />{{ t('移动') }}</AppButton>
            <AppButton v-if="selected.draft" variant="secondary" class="tool-btn" @click="publish()">
              <AppIcon name="upload" :size="14" />{{ t('发布') }}</AppButton>
            <AppButton variant="secondary" class="tool-btn" @click="toggleEnabled()">
              <AppIcon name="lock" :size="14" /> {{ selected.enabled ? t('停用') : t('启用') }}
            </AppButton>
            <AppButton variant="secondary" class="tool-btn" :title="t('查看修订并回滚')" @click="openRevisions()">
              <AppIcon name="corner-down-left" :size="14" />{{ t('修订') }}</AppButton>
            <AppButton variant="secondary" class="tool-btn" @click="openOriginal()">
              <AppIcon name="external" :size="14" />{{ t('原件') }}</AppButton>
            <AppButton variant="danger" class="tool-btn danger" :title="t('删除资料')" @click="confirmDelete = true">
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

      <section v-else class="lib-preview empty">
        <AppIcon name="book" :size="40" />
        <strong>{{ t('选中左侧文件即可预览与编辑') }}</strong>
        <span class="muted">{{ t('新建的文件是草稿，发布后才会进入检索。') }}</span>
      </section>
    </div>

    <AppModal :open="dialog === 'create'" :title="t('新建草稿')" size="sm" @close="dialog = ''">
      <label class="dialog-row">
        <span>{{ t('文件名') }}</span>
        <AppInput v-model="dialogName" :placeholder="t('例如 会议纪要.md')" />
      </label>
      <p class="dialog-hint">{{ t('当前目录：{0}', [cwd]) }}</p>
      <template #footer>
        <AppButton variant="secondary" class="tool-btn" @click="dialog = ''">{{ t('取消') }}</AppButton>
        <AppButton variant="primary" class="tool-btn primary" @click="submitCreate()">{{ t('新建') }}</AppButton>
      </template>
    </AppModal>

    <AppModal :open="dialog === 'rename'" :title="t('重命名')" size="sm" @close="dialog = ''">
      <label class="dialog-row">
        <span>{{ t('新名称') }}</span>
        <AppInput v-model="dialogName" :placeholder="selected?.name ?? ''" />
      </label>
      <template #footer>
        <AppButton variant="secondary" class="tool-btn" @click="dialog = ''">{{ t('取消') }}</AppButton>
        <AppButton variant="primary" class="tool-btn primary" @click="submitRename()">{{ t('保存') }}</AppButton>
      </template>
    </AppModal>

    <AppModal :open="dialog === 'move'" :title="t('移动到…')" size="sm" @close="dialog = ''">
      <label class="dialog-row">
        <span>{{ t('目标目录') }}</span>
        <AppInput v-model="dialogDir" placeholder="/docs" />
      </label>
      <p class="dialog-hint">{{ t('填相对资料库根目录的目录，根级填 /；文件本身留在原来的名字。') }}</p>
      <template #footer>
        <AppButton variant="secondary" class="tool-btn" @click="dialog = ''">{{ t('取消') }}</AppButton>
        <AppButton variant="primary" class="tool-btn primary" @click="submitMove()">{{ t('移动') }}</AppButton>
      </template>
    </AppModal>

    <AppModal :open="dialog === 'import'" :title="t('导入文件')" size="sm" @close="dialog = ''">
      <label class="dialog-row">
        <span>{{ t('源文件路径') }}</span>
        <AppInput v-model="dialogName" :placeholder="t('留空则点按钮选择文件')" />
      </label>
      <p class="dialog-hint">{{ t('当前目录：{0}。原件复制进资料库后保留原文件名。', [cwd]) }}</p>
      <template #footer>
        <AppButton variant="secondary" class="tool-btn" @click="dialog = ''">{{ t('取消') }}</AppButton>
        <AppButton variant="primary" class="tool-btn primary" @click="submitImport()">{{ t('导入') }}</AppButton>
      </template>
    </AppModal>

    <AppModal :open="dialog === 'revisions'" :title="t('修订历史')" size="sm" @close="dialog = ''">
      <ul class="rev-list">
        <li v-for="r in revisions" :key="r.rev">
          <span class="rev-no">#{{ r.rev }}</span>
          <span class="rev-size">{{ formatBytes(r.size) }}</span>
          <span class="muted">{{ formatTime(r.at) }}</span>
          <AppButton variant="text" size="sm" class="tool-btn tiny" @click="rollback(r.rev)">{{ t('回滚到此版') }}</AppButton>
        </li>
      </ul>
      <p v-if="!revisions.length" class="dialog-hint">{{ t('还没有修订快照，保存正文后会自动生成。') }}</p>
      <template #footer>
        <AppButton variant="secondary" class="tool-btn" @click="dialog = ''">{{ t('关闭') }}</AppButton>
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
        <AppButton variant="secondary" class="tool-btn" @click="confirmDelete = false">{{ t('取消') }}</AppButton>
        <AppButton variant="danger" class="tool-btn danger" @click="removeAsset()">{{ t('确认删除') }}</AppButton>
      </template>
    </AppModal>
  </section>
</template>

<style src="./LibraryPanel.css" scoped></style>
