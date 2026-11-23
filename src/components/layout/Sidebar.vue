<script setup lang="ts">
import { t } from '@/i18n'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { invoke } from '@tauri-apps/api/core'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppInput from '@/components/ui/AppInput.vue'
import ThemeToggle from './ThemeToggle.vue'
import UsageCard from './UsageCard.vue'
import RunHistory from '@/components/chat/RunHistory.vue'
// 活动项目是共享状态：这里切了，对话页的 watcher 会跟着换工作目录。
import { activateProject, activeProjectId, loadActiveProject } from '@/composables/useProject'
import { startNewSession } from '@/composables/useChatSession'
import { listRunHistory, pendingReplayIndex } from '@/composables/useReplay'
import { openPalette } from '@/composables/useGlobalSearch'
import { refreshUnread, unreadCount, useProactive } from '@/composables/useProactive'
import { focusFirstMenuItem, onMenuKeydown } from '@/composables/useMenuKeys'
// 菜单定位与贴底翻转与运行记录菜单同源，避免两处各写一版。
import { menuStyleFor, settleMenu } from '@/composables/useCtxMenu'
// 与首页共用同一份透明吉祥物：品牌图只有一处真源。
import mascotUrl from '@/assets/mascot.png'
import { listOf } from '@/utils/ipc'

interface Project {
  id: string
  name: string
  /** null = 用模板建的项目还没绑目录。 */
  path: string | null
  updated_at?: number
}

const router = useRouter()
const route = useRoute()

const projects = ref<Project[]>([])
const sortMode = ref<'updated' | 'name'>('updated')
/** 项目行会话计数：参考图的项目名旁徽标（22/2）。一次取全量 journal 按 cwd 分组。 */
const runCounts = ref<Record<string, number>>({})

const sortedProjects = computed(() => {
  if (sortMode.value === 'name') {
    return [...projects.value].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  }
  return [...projects.value].sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))
})

const mainNav = computed(() => [
  { name: 'chat', path: '/chat', title: t('对话'), icon: 'chat' },
  { name: 'inbox', path: '/inbox', title: t('收件箱'), icon: 'inbox' },
  { name: 'plugins', path: '/plugins', title: t('插件'), icon: 'puzzle' },
  // 「项目」不再占导航位：项目就在下方工作区列表里，入口重复反而多一层跳转。
  // 路由 /projects 保留——工作台返回按钮与深链仍落到它。
  { name: 'local-models', path: '/local-models', title: t('本地模型'), icon: 'cpu' },
  { name: 'capabilities', path: '/capabilities', title: t('专家 · 技能 · 连接器'), icon: 'grid' },
  { name: 'library', path: '/library', title: t('资料库'), icon: 'book' },
])

function isActive(path: string) {
  return route.path.startsWith(path)
}

/**
 * 桌面通知没有可靠的点击回调，用「通知后应用重新获得焦点」作为点击代理。
 * 后端只保留 90 秒内的定位目标，取一次即清，普通切窗口不会误跳。
 */
async function onWindowFocus() {
  const { takeFocus } = useProactive()
  const target = await takeFocus()
  if (!target) return
  await router.push({ name: 'inbox', query: { job: target.job_id, item: target.inbox_id } })
}

async function refreshProjects() {
  projects.value = await listOf(invoke<Project[]>('projects_list'))
  await loadActiveProject()
  // 计数是辅助信息：取不到就隐藏徽标，不拦项目列表。
  const runs = await listRunHistory()
  const counts: Record<string, number> = {}
  for (const p of projects.value) {
    if (!p.path) continue
    counts[p.id] = runs.filter((r) => r.cwd === p.path).length
  }
  runCounts.value = counts
}

/** 切项目后回对话页：`/chat` 已挂载时不会重新挂载，靠共享 ref 让对话页跟着换目录。 */
async function setActiveProject(id: string) {
  await activateProject(id)
  router.push('/chat')
}

/**
 * 运行记录展开/收缩（对齐 WorkDSH：记录挂在项目组下，点项目行的箭头开合）。
 * 会话内记忆即可，不必持久化——侧栏默认收起是干净的第一印象。
 */
const expanded = ref(new Set<string>())

/**
 * 移动断点（≤900px）：侧栏面板让位，只留图标轨道——入口仍全部可达。
 */
const narrow = ref(false)
let narrowQuery: MediaQueryList | null = null

function syncNarrow(e: MediaQueryList | MediaQueryListEvent) {
  narrow.value = e.matches
}

function toggleExpand(id: string) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

/**
 * 打开一条运行记录：先切到所属项目（对话页的回放一致性校验按活动目录过滤），
 * 再往共享信箱塞段号，最后跳对话页——信箱由对话页 watch 消费。
 */
async function openRecord(p: Project, index: number) {
  if (p.id !== activeProjectId.value) await activateProject(p.id)
  pendingReplayIndex.value = index
  router.push('/chat')
}

/**
 * 进项目工作台。
 *
 * 对话页只做对话；配置、文件、终端、浏览器都在项目工作台里 ——
 * 想用那些工具就得有一条明确的路过去，而不是把它们堆回对话两侧。
 */
function openWorkspace(id: string) {
  router.push(`/projects/${id}`)
}

/**
 * 新会话：先在 journal 落一条显式会话边界（否则运行记录会把新提问并进上一条），
 * 再轮次加一 → 对话页重挂载（消息与流式状态都在组件里，push 同路由清不掉）。
 * 桥会在内核存活时重启它——内核是内存态，不重启会把上一段对话带进新会话。
 */
async function newChat() {
  const dir = projects.value.find((p) => p.id === activeProjectId.value)?.path ?? null
  await invoke('pi_new_session', { cwd: dir }).catch(() => {})
  startNewSession()
  router.push('/chat')
}

/*
 * 项目行「···」菜单（对齐 WorkBuddy 项目右键菜单）：
 * 打开文件夹 / 重命名 / 从列表中移除。菜单本体用公共 ContextMenu 样式，
 * Teleport 到 body 避开侧栏 overflow 裁切（与 RunHistory 菜单同款策略）。
 */
type ProjectMenu = { project: Project; style: Record<string, string> } | null
const projectMenu = ref<ProjectMenu>(null)
const projectMenuEl = ref<HTMLElement | null>(null)
/** 菜单打开来源（「···」按钮）：Esc 关闭后焦点回到这里。 */
let menuReturnFocus: HTMLElement | null = null

function openProjectMenu(p: Project, el: Event) {
  const trigger = el.currentTarget as HTMLElement
  const anchor = (trigger.closest('li') as HTMLElement | null) ?? trigger
  menuReturnFocus = trigger
  projectMenu.value = { project: p, style: menuStyleFor(anchor, 180) }
  void nextTick(() => {
    if (projectMenu.value) projectMenu.value.style = settleMenu(anchor, projectMenu.value.style)
    focusFirstMenuItem(projectMenuEl.value)
  })
}

function closeProjectMenu() {
  projectMenu.value = null
}

function onDocClick(e: MouseEvent) {
  if (projectMenu.value && !(e.target as HTMLElement).closest('.ctx-menu')) closeProjectMenu()
}

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !projectMenu.value) return
  closeProjectMenu()
  menuReturnFocus?.focus()
  menuReturnFocus = null
}

/** 在系统文件管理器里显示项目目录（后端 reveal_item_in_dir）。 */
async function revealProject(p: Project) {
  closeProjectMenu()
  await invoke('project_reveal', { id: p.id }).catch((e) =>
    console.error('打开文件夹失败', e), // i18n-ignore: developer log
  )
}

/* ── 重命名（AppModal + AppInput，与资料库面板同款交互）──────── */
const renameOpen = ref(false)
const renameName = ref('')
let renameTarget: Project | null = null

function startRename(p: Project) {
  closeProjectMenu()
  renameTarget = p
  renameName.value = p.name
  renameOpen.value = true
}

async function submitRename() {
  if (!renameTarget) return
  const name = renameName.value.trim()
  if (!name || name === renameTarget.name) {
    renameOpen.value = false
    return
  }
  await invoke('project_rename', { id: renameTarget.id, name })
  renameOpen.value = false
  await refreshProjects()
}

/* ── 从列表中移除（确认弹窗；只摘引用，不删目录文件）────────── */
const removeOpen = ref(false)
let removeTarget: Project | null = null

function startRemove(p: Project) {
  closeProjectMenu()
  removeTarget = p
  removeOpen.value = true
}

async function submitRemove() {
  if (!removeTarget) return
  await invoke('project_remove', { id: removeTarget.id })
  removeOpen.value = false
  // 后端已同步清掉指向被移除项目的活动指针，这里把共享状态刷回来。
  await loadActiveProject()
  await refreshProjects()
}

onMounted(() => {
  narrowQuery = window.matchMedia('(max-width: 900px)')
  syncNarrow(narrowQuery)
  narrowQuery.addEventListener('change', syncNarrow)
  refreshProjects()
  // 未读角标：进应用就取一次；后续由 proactive://changed 事件驱动刷新。
  useProactive()
  refreshUnread()
  window.addEventListener('focus', onWindowFocus)
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  narrowQuery?.removeEventListener('change', syncNarrow)
  window.removeEventListener('focus', onWindowFocus)
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKey)
})

defineExpose({ refreshProjects })
</script>

<template>
  <aside class="sidebar" :class="{ narrow }">
    <nav class="rail" :aria-label="t('导航')">
      <!-- Overlay 标题栏下红绿灯浮在轨道顶部；整块轨道顶部即拖拽区。 -->
      <div class="rail-brand" data-tauri-drag-region :title="t('Pi Workbench')">
        <img :src="mascotUrl" alt="" />
      </div>
      <AppButton variant="icon" class="rail-new" :title="t('新会话')" @click="newChat">
        <AppIcon name="plus" :size="18" />
      </AppButton>
      <router-link
        v-for="n in mainNav"
        :key="n.name"
        :to="n.path"
        class="rail-item"
        :class="{ active: isActive(n.path) }"
        :title="n.title"
      >
        <AppIcon :name="n.icon" :size="18" />
        <span v-if="n.name === 'inbox' && unreadCount" class="rail-badge" :title="t('{0} 条未读', [unreadCount])">{{ unreadCount > 99 ? '99+' : unreadCount }}</span>
      </router-link>
      <div class="rail-foot">
        <ThemeToggle :collapsed="true" />
        <AppButton variant="icon" :title="t('设置')" @click="router.push('/settings')">
          <AppIcon name="settings" :size="17" />
        </AppButton>
      </div>
    </nav>

    <div class="side-panel">
      <div class="panel-head" data-tauri-drag-region>
        <span class="panel-title">Pi Workbench</span>
        <span class="panel-sub">{{ t('工作区') }}</span>
      </div>

      <div class="workspace">
        <div class="ws-head">
          <AppButton variant="secondary" class="ws-new" @click="newChat">
            <AppIcon name="plus" :size="15" />
            <span>{{ t('新会话') }}</span>
          </AppButton>
          <div class="ws-actions">
            <AppButton variant="icon" :title="t('全局搜索 (⌘K)')" @click="openPalette()">
              <AppIcon name="search" :size="14" />
            </AppButton>
            <AppButton
              variant="icon"
              :title="sortMode === 'updated' ? t('按名称排序') : t('按最近更新排序')"
              @click="sortMode = sortMode === 'updated' ? 'name' : 'updated'"
            >
              <AppIcon name="sort" :size="14" />
            </AppButton>
            <AppButton variant="icon" :title="t('新建项目')" @click="router.push('/projects')">
              <AppIcon name="folder-plus" :size="14" />
            </AppButton>
          </div>
        </div>
        <ul class="ws-list">
          <template v-for="p in sortedProjects" :key="p.id">
            <li class="ws-group" :class="{ active: p.id === activeProjectId }" @click="setActiveProject(p.id)">
              <AppIcon class="ws-folder" name="folder" :size="14" />
              <span class="ws-name" :title="p.name">{{ p.name }}</span>
              <AppButton
                v-if="p.path"
                variant="icon"
                class="ws-caret"
                :class="{ open: expanded.has(p.id) }"
                :title="expanded.has(p.id) ? t('收起运行记录') : t('展开运行记录')"
                :aria-expanded="expanded.has(p.id)"
                @click.stop="toggleExpand(p.id)"
              >
                <AppIcon name="chevron-right" :size="12" />
              </AppButton>
              <span v-if="runCounts[p.id]" class="ws-count" :title="t('{0} 条会话记录', [runCounts[p.id]])">{{ runCounts[p.id] }}</span>
              <AppButton
                variant="icon"
                class="ws-more"
                :title="t('更多操作')"
                aria-haspopup="menu"
                :aria-expanded="projectMenu?.project.id === p.id"
                @click.stop="openProjectMenu(p, $event)"
              >
                <AppIcon name="more-horizontal" :size="14" />
              </AppButton>
              <AppButton
                variant="icon"
                class="ws-open"
                :title="t('打开项目工作台（配置 / 文件 / 终端 / 浏览器）')"
                @click.stop="openWorkspace(p.id)"
              >
                <AppIcon name="external" :size="12" />
              </AppButton>
            </li>
            <li v-if="p.path && expanded.has(p.id)" class="ws-runs">
              <RunHistory :cwd="p.path" @open="openRecord(p, $event)" />
            </li>
          </template>
          <li v-if="!projects.length" class="ws-empty">{{ t('暂无项目') }}</li>
        </ul>
      </div>

      <div class="foot">
        <UsageCard />
      </div>
    </div>
  </aside>

    <!-- 项目行「···」菜单：Teleport 到 body，公共 ctx-menu 样式 -->
    <Teleport to="body">
      <div v-if="projectMenu" ref="projectMenuEl" class="ctx-menu" :style="projectMenu.style" role="menu" @keydown="onMenuKeydown">
        <AppButton
          v-if="projectMenu.project.path"
          variant="menu-item"
          class="ctx-menu-item"
          role="menuitem"
          @click="revealProject(projectMenu.project)"
        >
          <AppIcon name="folder-open" :size="15" />
          <span>{{ t('打开文件夹') }}</span>
        </AppButton>
        <AppButton
          variant="menu-item"
          class="ctx-menu-item"
          role="menuitem"
          @click="startRename(projectMenu.project)"
        >
          <AppIcon name="edit" :size="15" />
          <span>{{ t('重命名') }}</span>
        </AppButton>
        <AppButton
          variant="menu-item"
          class="ctx-menu-item danger"
          role="menuitem"
          @click="startRemove(projectMenu.project)"
        >
          <AppIcon name="trash" :size="15" />
          <span>{{ t('从列表中移除') }}</span>
        </AppButton>
      </div>
    </Teleport>

    <!-- 重命名 -->
    <AppModal :open="renameOpen" :title="t('重命名项目')" size="sm" @close="renameOpen = false">
      <label class="ws-dialog-row">
        <span>{{ t('新名称') }}</span>
        <AppInput v-model="renameName" :placeholder="renameTarget?.name ?? ''" @keydown.enter="submitRename" />
      </label>
      <template #footer>
        <AppButton variant="secondary" class="ws-btn" @click="renameOpen = false">{{ t('取消') }}</AppButton>
        <AppButton variant="primary" class="ws-btn primary" @click="submitRename">{{ t('保存') }}</AppButton>
      </template>
    </AppModal>

    <!-- 从列表中移除：只摘项目引用，目录里的文件不动 -->
    <AppModal :open="removeOpen" :title="t('从列表中移除项目')" size="sm" @close="removeOpen = false">
      <p class="ws-dialog-text">{{ t('将从工作区列表移除「{0}」。绑定的目录与里面的文件不会被删除。', [removeTarget?.name]) }}</p>
      <template #footer>
        <AppButton variant="secondary" class="ws-btn" @click="removeOpen = false">{{ t('取消') }}</AppButton>
        <AppButton variant="danger" class="ws-btn danger" @click="submitRemove">{{ t('移除') }}</AppButton>
      </template>
    </AppModal>
</template>

<style src="@/components/ui/ContextMenu.css" scoped></style>
<style src="./Sidebar.css" scoped></style>
