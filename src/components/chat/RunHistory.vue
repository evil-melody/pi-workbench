<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import AppCheckbox from '@/components/ui/AppCheckbox.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppInput from '@/components/ui/AppInput.vue'
import RunBulkBar from './RunBulkBar.vue'
import RunHistoryMenu from './RunHistoryMenu.vue'
import { listRunHistory, type RunRecord } from '@/composables/useReplay'
import { useRunMeta, type RunMetaPatch } from '@/composables/useRunMeta'
import { allSelected, selectAll, toggleSelected } from '@/utils/runSelection'
import { buildRunShareText } from '@/utils/runShare'
import { timeAgo } from '@/utils/timeAgo'

/**
 * 运行记录（对齐 WorkDSH「之前的运行记录」）：journal 按 session_open
 * 分段的历史会话列表，**默认 5 条**，「加载更多」每次再看 5 条。
 * 空列表整体隐藏——首页不该出现一块永远空着的板子。
 *
 * 行 hover 露「···」菜单（置顶 / 重命名 / 分享 / 独立窗口 / 打开文件夹 /
 * 批量操作 / 归档 / 删除）；「批量操作」进入多选态，底部操作栏逐条
 * invoke run_meta_update。所有元数据写操作走 useRunMeta，
 * journal 段数据走 listRunHistory（后端已合并 pinned/archived/title）。
 */
const props = withDefaults(
  defineProps<{
    /** 只列该工作目录的会话；空串 = 全部。 */
    cwd?: string
    /** 每页条数（默认 5）。 */
    pageSize?: number
  }>(),
  { cwd: '', pageSize: 5 },
)

const emit = defineEmits<{ open: [index: number] }>()

const records = ref<RunRecord[]>([])
const loaded = ref(false)
const visible = ref(props.pageSize)
/** 「查看归档 N 条」开关：true 时列表带出归档记录（置灰展示）。 */
const showArchived = ref(false)

const meta = useRunMeta()

/** 行内 toast（分享成功 / 操作失败等瞬时反馈）。Teleport 到 body 固定底栏。 */
const toast = ref('')
let toastTimer: ReturnType<typeof setTimeout> | null = null
function flash(text: string) {
  toast.value = text
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = ''), 2600)
}
onBeforeUnmount(() => {
  if (toastTimer) clearTimeout(toastTimer)
})

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * 刷新：journal 段列表（含/不含归档按当前开关）+ run_meta sidecar
 * （用于归档计数）。两者都是本地读，失败各自降级不互相阻断。
 */
async function refresh() {
  const dir = props.cwd || undefined
  // meta.refresh 内部已 catch（失败降级为空 entries），不会 reject。
  const [list] = await Promise.all([
    listRunHistory(dir, showArchived.value).catch(() => [] as RunRecord[]),
    meta.refresh(),
  ])
  records.value = list
  // 已不在列表里的段号（删除/过滤）从选中集摘掉，避免「已选 3 条」只够 2 条可操作。
  const alive = new Set(list.map((r) => r.index))
  selected.value = selected.value.filter((i) => alive.has(i))
  loaded.value = true
}

onMounted(refresh)

defineExpose({ refresh })

const shown = computed(() => records.value.slice(0, visible.value))
const hasMore = computed(() => records.value.length > visible.value)

/** 归档条数（sidecar 里 archived 且未删除的记录；cwd 为空 = 全部项目）。 */
const archivedCount = computed(() => {
  const dir = normCwd(props.cwd)
  return meta.entries.value.filter(
    (e) => (!dir || normCwd(e.cwd) === dir) && e.archived && !e.deleted,
  ).length
})

function normCwd(s: string | undefined): string {
  return String(s ?? '').replace(/\/+$/, '')
}

function loadMore() {
  visible.value += props.pageSize
}

async function toggleArchived() {
  showArchived.value = !showArchived.value
  visible.value = props.pageSize
  await refresh()
}

/** 标题兜底：极少数段没有任何用户消息（只起了内核没说话）。 */
function titleOf(r: RunRecord): string {
  return r.title || '（该会话没有用户消息）'
}

/* ── 单条元数据操作 ─────────────────────────────────────────── */

/** 打补丁 → 刷新列表。失败 toast 提示，返回是否成功（调用方补成功反馈）。 */
async function patchOne(r: RunRecord, patch: RunMetaPatch): Promise<boolean> {
  try {
    await meta.update(r.cwd, r.index, patch)
    await refresh()
    return true
  } catch (e) {
    flash(`操作失败：${errText(e)}`)
    return false
  }
}

async function togglePin(r: RunRecord) {
  const was = r.pinned === true
  if (await patchOne(r, { pinned: !was })) flash(was ? '已取消置顶' : '已置顶')
}

async function toggleArchive(r: RunRecord) {
  const was = r.archived === true
  if (await patchOne(r, { archived: !was })) flash(was ? '已取消归档' : '已归档')
}

/* ── 重命名（AppModal + AppInput，写 title）──────────────────── */
const renameOpen = ref(false)
const renameTarget = ref<RunRecord | null>(null)
const renameText = ref('')

function startRename(r: RunRecord) {
  renameTarget.value = r
  renameText.value = r.title
  renameOpen.value = true
}

async function submitRename() {
  const r = renameTarget.value
  const name = renameText.value.trim()
  renameOpen.value = false
  if (!r || !name || name === r.title) return
  if (await patchOne(r, { title: name })) flash('已重命名')
}

/* ── 删除（AppModal 确认，软删除）───────────────────────────── */
const deleteOpen = ref(false)
const deleteTarget = ref<RunRecord | null>(null)

function startDelete(r: RunRecord) {
  deleteTarget.value = r
  deleteOpen.value = true
}

async function confirmDelete() {
  const r = deleteTarget.value
  deleteOpen.value = false
  if (!r) return
  if (await patchOne(r, { deleted: true })) flash('已删除 1 条记录')
}

/* ── 分享任务（markdown 摘要进剪贴板，失败降级手动复制）──────── */
const shareFallback = ref<string | null>(null)

async function shareRun(r: RunRecord) {
  const text = buildRunShareText({
    title: titleOf(r),
    startedAtMs: r.startedAtMs,
    endedAtMs: r.endedAtMs,
    prompts: r.prompts,
    cwd: r.cwd,
  })
  try {
    await navigator.clipboard.writeText(text)
    flash('已复制任务摘要')
  } catch {
    // 剪贴板被拒（未聚焦窗口 / 权限禁用）：不假装成功，弹出来让人手动复制。
    shareFallback.value = text
  }
}

/* ── 系统联动（后端命令，失败 toast）────────────────────────── */
async function openInWindow(r: RunRecord) {
  try {
    await invoke('open_replay_window', { cwd: r.cwd, index: r.index })
  } catch (e) {
    flash(`打开独立窗口失败：${errText(e)}`)
  }
}

async function openFolder(r: RunRecord) {
  try {
    await invoke('reveal_path', { path: r.cwd })
  } catch (e) {
    flash(`打开文件夹失败：${errText(e)}`)
  }
}

/* ── 批量操作（多选态）─────────────────────────────────────── */
const bulkMode = ref(false)
const selected = ref<number[]>([])
const bulkRunning = ref(false)
const menuRef = ref<InstanceType<typeof RunHistoryMenu> | null>(null)

function enterBulk() {
  bulkMode.value = true
  selected.value = []
}

function exitBulk() {
  bulkMode.value = false
  selected.value = []
}

function toggleSelect(index: number) {
  selected.value = toggleSelected(selected.value, index)
}

const allChecked = computed(() => allSelected(selected.value, shown.value.map((r) => r.index)))

function toggleSelectAll() {
  selected.value = allChecked.value ? [] : selectAll(shown.value.map((r) => r.index))
}

const selectedRecords = computed(() =>
  records.value.filter((r) => selected.value.includes(r.index)),
)

/**
 * 批量执行：对选中记录逐条 invoke run_meta_update（后端一次只收一条），
 * 全部完成后统一刷新一次列表。失败即停并提示——部分成功好过假装全部成功。
 */
async function runBulk(patch: RunMetaPatch, doneText: string) {
  const targets = selectedRecords.value.map((r) => ({ cwd: r.cwd, index: r.index }))
  if (!targets.length || bulkRunning.value) return
  bulkRunning.value = true
  try {
    await meta.updateMany(targets, patch)
    selected.value = []
    await refresh()
    flash(doneText)
  } catch (e) {
    await refresh()
    flash(`批量操作失败：${errText(e)}`)
  } finally {
    bulkRunning.value = false
  }
}

function onBulkPin() {
  const n = selectedRecords.value.length
  void runBulk({ pinned: true }, `已置顶 ${n} 条记录`)
}
function onBulkArchive() {
  const n = selectedRecords.value.length
  void runBulk({ archived: true }, `已归档 ${n} 条记录`)
}
function onBulkDelete() {
  const n = selectedRecords.value.length
  void runBulk({ deleted: true }, `已删除 ${n} 条记录`)
}

/* ── 行点击 / 「···」菜单 ───────────────────────────────────── */

/** 多选态下行点击 = 勾选/取消；常态下行点击 = 打开回放。 */
function onRowClick(r: RunRecord) {
  if (bulkMode.value) {
    toggleSelect(r.index)
    return
  }
  emit('open', r.index)
}

function openMenu(r: RunRecord, el: Event) {
  const anchor = (el.currentTarget as HTMLElement).closest('.rh-item') as HTMLElement | null
  if (anchor) menuRef.value?.open(r, anchor)
}
</script>

<template>
  <section v-if="loaded && records.length" class="run-history">
    <ol class="rh-list">
      <li v-for="r in shown" :key="r.index">
        <div
          class="rh-item"
          :class="{
            pinned: r.pinned,
            archived: r.archived,
            checked: bulkMode && selected.includes(r.index),
          }"
          role="button"
          tabindex="0"
          :title="titleOf(r)"
          @click="onRowClick(r)"
          @keydown.enter="onRowClick(r)"
        >
          <AppCheckbox
            v-if="bulkMode"
            class="rh-check"
            :model-value="selected.includes(r.index)"
            label=""
            @update:model-value="toggleSelect(r.index)"
          />
          <AppIcon v-if="r.pinned" class="rh-pin" name="star" :size="12" />
          <span class="rh-title">{{ titleOf(r) }}</span>
          <span class="rh-meta">
            <span v-if="r.prompts" class="rh-prompts">{{ r.prompts }} 轮</span>
            <span class="rh-time">{{ timeAgo(r.startedAtMs) }}</span>
          </span>
          <button
            v-if="!bulkMode"
            type="button"
            class="rh-more-btn"
            title="更多操作"
            @click.stop="openMenu(r, $event)"
          >
            <AppIcon name="more-horizontal" :size="14" />
          </button>
        </div>
      </li>
    </ol>

    <RunBulkBar
      v-if="bulkMode"
      :selected-count="selected.length"
      :total="shown.length"
      :all-checked="allChecked"
      :running="bulkRunning"
      @toggle-all="toggleSelectAll"
      @pin="onBulkPin"
      @archive="onBulkArchive"
      @delete="onBulkDelete"
      @cancel="exitBulk"
    />

    <button v-if="hasMore" type="button" class="rh-more" @click="loadMore">
      加载更多（还有 {{ records.length - visible }} 条）
    </button>

    <button
      v-if="archivedCount > 0 || showArchived"
      type="button"
      class="rh-more"
      @click="toggleArchived"
    >
      {{ showArchived ? '收起归档' : `查看归档 ${archivedCount} 条` }}
    </button>

    <!-- 「···」全量菜单：Teleport 到 body，公共 ctx-menu 样式 -->
    <RunHistoryMenu
      ref="menuRef"
      @open="(r) => emit('open', r.index)"
      @pin="togglePin"
      @rename="startRename"
      @share="shareRun"
      @window="openInWindow"
      @folder="openFolder"
      @bulk="enterBulk"
      @archive="toggleArchive"
      @delete="startDelete"
    />

    <!-- 重命名 -->
    <AppModal :open="renameOpen" title="重命名记录" size="sm" @close="renameOpen = false">
      <label class="rh-dialog-row">
        <span>新标题</span>
        <AppInput
          v-model="renameText"
          placeholder="给这条运行记录起个名字"
          @keydown.enter="submitRename"
        />
      </label>
      <template #footer>
        <button class="rh-btn" @click="renameOpen = false">取消</button>
        <button class="rh-btn primary" @click="submitRename">保存</button>
      </template>
    </AppModal>

    <!-- 删除（软删除确认） -->
    <AppModal :open="deleteOpen" title="删除这条记录？" size="sm" @close="deleteOpen = false">
      <p class="rh-dialog-text">
        将删除「{{ deleteTarget ? titleOf(deleteTarget) : '' }}」。记录文件仍会保留，
        但它不再出现在运行记录里。
      </p>
      <template #footer>
        <button class="rh-btn" @click="deleteOpen = false">取消</button>
        <button class="rh-btn danger" @click="confirmDelete">删除</button>
      </template>
    </AppModal>

    <!-- 分享降级：剪贴板不可用时的手动复制兜底 -->
    <AppModal
      :open="shareFallback !== null"
      title="复制失败，请手动复制"
      size="sm"
      @close="shareFallback = null"
    >
      <p class="rh-dialog-text">
        浏览器拒绝了剪贴板写入（常见于窗口未聚焦或权限被禁）。请全选下面内容手动复制：
      </p>
      <pre class="rh-share-pre">{{ shareFallback }}</pre>
      <template #footer>
        <button class="rh-btn primary" @click="shareFallback = null">知道了</button>
      </template>
    </AppModal>
  </section>

  <!-- toast 在 section 外：批量删完最后一条时列表整体隐藏，操作反馈仍要看得见 -->
  <Teleport to="body">
    <p v-if="toast" class="rh-toast" role="status">{{ toast }}</p>
  </Teleport>
</template>

<style src="./RunHistory.css" scoped></style>
