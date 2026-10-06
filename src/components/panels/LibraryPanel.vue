<script setup lang="ts">
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
import { open } from '@tauri-apps/plugin-dialog'
import {
  CONVERT_TEXT,
  KIND_TEXT,
  ORIGIN_TEXT,
  describeLibraryError,
  formatBytes,
  formatTime,
  libraryCreate,
  libraryImport,
  libraryList,
  libraryMarks,
  libraryMove,
  libraryOpen,
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
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppTextarea from '@/components/ui/AppTextarea.vue'
import MemoryView from '@/views/MemoryView.vue'

type View = 'library' | 'search' | 'recent' | 'outputs' | 'memory'
type Dialog = '' | 'create' | 'rename' | 'move' | 'import' | 'revisions'

const views: { key: View; label: string; icon: string }[] = [
  { key: 'library', label: '资料库', icon: 'book' },
  { key: 'search', label: '搜索', icon: 'search' },
  { key: 'recent', label: '最近', icon: 'clock' },
  { key: 'outputs', label: '输出', icon: 'box' },
  { key: 'memory', label: '记忆', icon: 'database' },
]

const route = useRoute()

/** 记忆层并入资料库：/library?view=memory 直接落到「记忆」tab。 */
const VIEW_KEYS: View[] = ['library', 'search', 'recent', 'outputs', 'memory']
function viewFromQuery(): View {
  const q = route.query.view
  const value = Array.isArray(q) ? q[0] : q
  return VIEW_KEYS.includes(value as View) ? (value as View) : 'library'
}

const view = ref<View>(viewFromQuery())
const busy = ref(false)
const status = ref('')
const stats = ref<LibraryStats | null>(null)
const assets = ref<LibraryAssetView[]>([])
const marks = ref<LibraryAssetView[]>([])
const children = ref<Record<string, LibraryNode[]>>({})
const expanded = ref<Set<string>>(new Set())
const cwd = ref('/')
const keyword = ref('')
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
  a.searchable ? CONVERT_TEXT.ready : CONVERT_TEXT[a.enabled ? 'failed' : 'skipped']

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
    status.value = '磁盘上有这个文件，但还没登记为资料；先在目录里选中它再操作。'
    return
  }
  await openAsset(id)
}

async function openAsset(id: string) {
  try {
    const body = await libraryRead(id)
    selectedId.value = id
    content.value = body.content
    dirty.value = false
    status.value = body.truncated ? '正文超过 512 KiB，已截断显示' : ''
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
    status.value = '已发布：现在可以被检索到'
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
    status.value = '已删除原件、索引与修订快照'
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
    status.value = `已回滚到 #${rev}`
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
    status.value = describeLibraryError(null, '请填写文件名')
    return
  }
  try {
    // 新建即草稿：不发布就不进检索，这是草稿发布流程的起点。
    const asset = await libraryCreate(cwd.value, name, '')
    dialog.value = ''
    dialogName.value = ''
    selectedId.value = asset.id
    status.value = '已新建草稿，写正文后点「发布」才会进入检索'
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
    status.value = describeLibraryError(null, '请填写新名称')
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
    status.value = '已导入原件，转换器结果见转换状态'
  } catch (e) {
    status.value = describeLibraryError(e, `导入失败：${String(e)}`)
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
    const body = await libraryRead(id)
    content.value = body.content
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

// 兼容来自 /agent-ops/memory 的重定向：query 变化时同步切换 tab。
watch(
  () => route.query.view,
  (q) => {
    const value = Array.isArray(q) ? q[0] : q
    if (value && VIEW_KEYS.includes(value as View)) view.value = value as View
  },
)

refresh()
loadTree('/')
</script>

<template>
  <section class="wd-library">
    <header class="lib-header">
      <div class="lib-title">
        <h1>资料库</h1>
        <p class="muted">浏览、检索并维护项目内的文件资产。原件始终保留，检索文本只是产物。</p>
      </div>
      <div v-if="stats" class="lib-quota">
        <div class="quota-bar" role="img" :aria-label="`已用 ${formatBytes(stats.used_bytes)}`">
          <span :style="{ width: `${usedRatio * 100}%` }"></span>
        </div>
        <span class="quota-text">
          {{ stats.asset_count }} 份 · {{ formatBytes(stats.used_bytes) }} / {{ formatBytes(stats.max_total_bytes) }}
        </span>
      </div>
    </header>

    <div class="lib-toolbar">
      <nav class="lib-tabs">
        <button
          v-for="v in views"
          :key="v.key"
          class="lib-tab"
          :class="{ active: view === v.key }"
          @click="view = v.key"
        >
          <AppIcon :name="v.icon" :size="14" />
          {{ v.label }}
        </button>
      </nav>
      <div class="lib-tools">
        <!-- 记忆 tab 的检索由记忆层自己负责，这里的资料库检索框不适用。 -->
        <AppInput
          v-if="view !== 'memory'"
          v-model="keyword"
          :placeholder="view === 'library' ? '在当前目录下筛选' : '搜索资料库全文'"
        />
        <button
          v-if="view === 'library'"
          class="tool-btn"
          title="在当前目录下新建草稿"
          @click="openCreate()"
        >
          <AppIcon name="folder-plus" :size="14" /> 新建
        </button>
        <button
          v-if="view === 'library'"
          class="tool-btn"
          title="导入外部文件"
          @click="dialog = 'import'"
        >
          <AppIcon name="upload" :size="14" /> 导入
        </button>
        <button class="tool-btn" title="刷新" :disabled="busy" @click="refresh()">
          <AppIcon name="refresh" :size="14" />
        </button>
      </div>
    </div>

    <!-- 记忆 tab 下资料库自身的加载错误与本页无关，交给内嵌的记忆视图表达状态。 -->
    <div v-if="status && view !== 'memory'" class="lib-status err" role="alert">{{ status }}</div>

    <section v-if="view === 'memory'" class="lib-memory-shell">
      <MemoryView embedded />
    </section>

    <div v-else class="lib-body">
      <aside v-if="view === 'search'" class="lib-tree">
        <div class="tree-head"><span class="muted">命中结果</span></div>
        <ul class="tree-list">
          <li
            v-for="hit in hits"
            :key="`${hit.asset_id}-${hit.location ?? 'name'}`"
            class="hit-node"
            @click="openHit(hit)"
          >
            <div class="hit-top">
              <AppIcon name="search" :size="12" />
              <span class="tree-name">{{ hit.name }}</span>
              <span class="hit-convert" :class="{ bad: hit.convert_status !== 'ready' }">
                {{ CONVERT_TEXT[hit.convert_status] ?? hit.convert_status }}
              </span>
            </div>
            <div class="hit-meta">
              <span>目录 {{ hit.dir }}</span>
              <span>{{ KIND_TEXT[hit.kind] ?? hit.kind }}</span>
              <span>来源 {{ ORIGIN_TEXT[hit.origin.kind] ?? hit.origin.kind }}</span>
              <span>修订 #{{ hit.revision }}</span>
              <span v-if="hit.location">{{ hit.location }}</span>
            </div>
            <p class="hit-snippet">{{ hit.snippet }}</p>
          </li>
          <li v-if="!hits.length" class="tree-empty">
            {{ keyword.trim() ? '没有命中，换个关键词试试' : '输入关键词做全文检索' }}
          </li>
        </ul>
      </aside>

      <aside v-else-if="view === 'recent' || view === 'outputs'" class="lib-tree">
        <div class="tree-head">
          <span class="muted">{{ view === 'outputs' ? '最近写入' : '最近打开' }}</span>
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
            <span class="tree-name">{{ m.name }}</span>
            <span class="tree-badge">{{ m.dir }}</span>
          </li>
          <li v-if="!marks.length" class="tree-empty">还没有记录</li>
        </ul>
      </aside>

      <aside v-else class="lib-tree">
        <div class="tree-head"><span class="muted">目录</span></div>
        <ul class="tree-list">
          <li
            v-for="item in renderTree('/')"
            :key="item.node.path"
            class="tree-node"
            :class="{ active: item.node.asset_id && item.node.asset_id === selectedId, dir: item.node.is_dir }"
            :style="{ paddingLeft: `${12 + item.depth * 16}px` }"
            @click="openNode(item.node)"
          >
            <AppIcon :name="fileIcon(item.node)" :size="14" />
            <span class="tree-name">{{ item.node.name }}</span>
            <span
              v-if="item.node.asset_id && assets.find((a) => a.id === item.node.asset_id)?.draft"
              class="tree-flag"
            >
              草稿
            </span>
            <span
              v-else-if="
                item.node.asset_id &&
                assets.find((a) => a.id === item.node.asset_id) &&
                !assets.find((a) => a.id === item.node.asset_id)?.enabled
              "
              class="tree-flag off"
            >
              停用
            </span>
          </li>
          <li v-if="!rowsOf('/').length" class="tree-empty">还没有文件，先新建一个草稿</li>
        </ul>
      </aside>

      <section v-if="selected" class="lib-preview">
        <div class="preview-head">
          <div class="preview-title">
            <AppIcon name="file" :size="14" /> {{ selected.name }}
            <span v-if="selected.draft" class="preview-flag">草稿</span>
            <span v-if="dirty" class="preview-dirty">未保存</span>
          </div>
          <div class="preview-actions">
            <button class="tool-btn" :disabled="!dirty" @click="save()">
              <AppIcon name="check" :size="14" /> 保存
            </button>
            <button class="tool-btn" title="重命名" @click="openRename()">
              <AppIcon name="edit" :size="14" /> 重命名
            </button>
            <button class="tool-btn" title="移动到其它目录" @click="openMove()">
              <AppIcon name="corner-down-left" :size="14" /> 移动
            </button>
            <button v-if="selected.draft" class="tool-btn" @click="publish()">
              <AppIcon name="upload" :size="14" /> 发布
            </button>
            <button class="tool-btn" @click="toggleEnabled()">
              <AppIcon name="lock" :size="14" /> {{ selected.enabled ? '停用' : '启用' }}
            </button>
            <button class="tool-btn" title="查看修订并回滚" @click="openRevisions()">
              <AppIcon name="corner-down-left" :size="14" /> 修订
            </button>
            <button class="tool-btn" @click="openOriginal()">
              <AppIcon name="external" :size="14" /> 原件
            </button>
            <button class="tool-btn danger" title="删除资料" @click="confirmDelete = true">
              <AppIcon name="trash" :size="14" /> 删除
            </button>
          </div>
        </div>

        <div class="preview-meta">
          <span>目录 {{ selected.dir }}</span>
          <span>{{ KIND_TEXT[selected.kind] ?? selected.kind }}</span>
          <span>来源 {{ ORIGIN_TEXT[selected.origin.kind] ?? selected.origin.kind }}{{ selected.origin.detail ? ` · ${selected.origin.detail}` : '' }}</span>
          <span>修订 #{{ selected.revision }}</span>
          <span>{{ formatBytes(selected.size) }}</span>
          <span :class="{ 'meta-bad': !selected.searchable }">
            转换 {{ convertText(selected) }}
          </span>
          <span class="muted">{{ formatTime(selected.updated_at) }}</span>
        </div>
        <div v-if="selected.convert_error && !selected.searchable" class="preview-note">
          转换失败原因：{{ selected.convert_error }}（原件未改动）
        </div>

        <AppTextarea
          v-if="selected.kind === 'markdown' || selected.kind === 'text' || selected.kind === 'html'"
          v-model="content"
          class="preview-editor"
          mono
        />
        <div v-else class="preview-binary">
          <AppIcon name="pdf" :size="28" />
          <span>该格式不在正文通道内，点「原件」用系统应用打开。</span>
        </div>
      </section>

      <section v-else class="lib-preview empty">
        <AppIcon name="book" :size="40" />
        <strong>选中左侧文件即可预览与编辑</strong>
        <span class="muted">新建的文件是草稿，发布后才会进入检索。</span>
      </section>
    </div>

    <AppModal :open="dialog === 'create'" title="新建草稿" size="sm" @close="dialog = ''">
      <label class="dialog-row">
        <span>文件名</span>
        <AppInput v-model="dialogName" placeholder="例如 会议纪要.md" />
      </label>
      <p class="dialog-hint">当前目录：{{ cwd }}</p>
      <template #footer>
        <button class="tool-btn" @click="dialog = ''">取消</button>
        <button class="tool-btn primary" @click="submitCreate()">新建</button>
      </template>
    </AppModal>

    <AppModal :open="dialog === 'rename'" title="重命名" size="sm" @close="dialog = ''">
      <label class="dialog-row">
        <span>新名称</span>
        <AppInput v-model="dialogName" :placeholder="selected?.name ?? ''" />
      </label>
      <template #footer>
        <button class="tool-btn" @click="dialog = ''">取消</button>
        <button class="tool-btn primary" @click="submitRename()">保存</button>
      </template>
    </AppModal>

    <AppModal :open="dialog === 'move'" title="移动到…" size="sm" @close="dialog = ''">
      <label class="dialog-row">
        <span>目标目录</span>
        <AppInput v-model="dialogDir" placeholder="/docs" />
      </label>
      <p class="dialog-hint">填相对资料库根目录的目录，根级填 /；文件本身留在原来的名字。</p>
      <template #footer>
        <button class="tool-btn" @click="dialog = ''">取消</button>
        <button class="tool-btn primary" @click="submitMove()">移动</button>
      </template>
    </AppModal>

    <AppModal :open="dialog === 'import'" title="导入文件" size="sm" @close="dialog = ''">
      <label class="dialog-row">
        <span>源文件路径</span>
        <AppInput v-model="dialogName" placeholder="留空则点按钮选择文件" />
      </label>
      <p class="dialog-hint">当前目录：{{ cwd }}。原件复制进资料库后保留原文件名。</p>
      <template #footer>
        <button class="tool-btn" @click="dialog = ''">取消</button>
        <button class="tool-btn primary" @click="submitImport()">导入</button>
      </template>
    </AppModal>

    <AppModal :open="dialog === 'revisions'" title="修订历史" size="sm" @close="dialog = ''">
      <ul class="rev-list">
        <li v-for="r in revisions" :key="r.rev">
          <span class="rev-no">#{{ r.rev }}</span>
          <span class="rev-size">{{ formatBytes(r.size) }}</span>
          <span class="muted">{{ formatTime(r.at) }}</span>
          <button class="tool-btn tiny" @click="rollback(r.rev)">回滚到此版</button>
        </li>
      </ul>
      <p v-if="!revisions.length" class="dialog-hint">还没有修订快照，保存正文后会自动生成。</p>
      <template #footer>
        <button class="tool-btn" @click="dialog = ''">关闭</button>
      </template>
    </AppModal>

    <AppModal
      :open="confirmDelete"
      title="删除资料"
      size="sm"
      @close="confirmDelete = false"
    >
      <p>删除「{{ selected?.name }}」会同时删掉索引与全部修订快照，原件不可恢复。</p>
      <template #footer>
        <button class="tool-btn" @click="confirmDelete = false">取消</button>
        <button class="tool-btn danger" @click="removeAsset()">确认删除</button>
      </template>
    </AppModal>
  </section>
</template>

<style src="./LibraryPanel.css" scoped></style>
