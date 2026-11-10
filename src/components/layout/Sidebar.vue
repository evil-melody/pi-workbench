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
import { pendingReplayIndex } from '@/composables/useReplay'
import { openPalette } from '@/composables/useGlobalSearch'
import { refreshUnread, unreadCount, useProactive } from '@/composables/useProactive'
// F19：项目行时间戳与运行记录同一套格式（无空格的「N分钟前」），不再各写一份相对时间。
import { timeAgo } from '@/utils/timeAgo'
import { focusFirstMenuItem, onMenuKeydown } from '@/composables/useMenuKeys'
// 与首页共用同一份透明吉祥物：品牌图只有一处真源。
import mascotUrl from '@/assets/mascot.png'

interface Project {
  id: string
  name: string
  /** null = 用模板建的项目还没绑目录。 */
  path: string | null
  updated_at?: number
}

const router = useRouter()
const route = useRoute()

const collapsed = ref(false)
const projects = ref<Project[]>([])
const sortMode = ref<'updated' | 'name'>('updated')

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
  { name: 'projects', path: '/projects', title: t('项目'), icon: 'share-network' },
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
  await router.push({ name: 'inbox', query: { job: target.jobId, item: target.inboxId } })
}

async function refreshProjects() {
  projects.value = await invoke<Project[]>('projects_list').catch(() => [])
  await loadActiveProject()
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
 * 移动断点（≤900px）：侧栏自动收成图标轨道，项目快捷列表让位给「项目」页入口。
 * 不用半隐藏方案——窄屏下每个入口仍可达，只是换成图标 + 页面入口。
 */
const narrow = ref(false)
const collapsedView = computed(() => collapsed.value || narrow.value)
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

/** 新会话：轮次加一 → 对话页重挂载（消息与流式状态都在组件里，push 同路由清不掉）。 */
function newChat() {
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
  const anchor = trigger.closest('li') as HTMLElement | null
  const r = anchor?.getBoundingClientRect()
  if (!r) return
  menuReturnFocus = trigger
  const width = 180
  const left = Math.min(Math.max(8, r.right - width), window.innerWidth - width - 8)
  projectMenu.value = { project: p, style: { left: `${left}px`, top: `${r.bottom + 6}px` } }
  void nextTick(() => focusFirstMenuItem(projectMenuEl.value))
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

function toggleCollapse() {
  collapsed.value = !collapsed.value
  localStorage.setItem('pi-workbench:sidebar-collapsed', collapsed.value ? '1' : '0')
}

onMounted(() => {
  const saved = localStorage.getItem('pi-workbench:sidebar-collapsed')
  if (saved === '1') collapsed.value = true
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
  <aside class="sidebar" :class="{ collapsed: collapsedView }">
    <div class="brand">
      <div class="mark">
        <img :src="mascotUrl" alt="" />
      </div>
      <div v-if="!collapsedView" class="btext">
        <div class="bname">Pi Workbench</div>
      </div>
      <AppButton v-if="!narrow" variant="icon" class="collapse" :title="collapsedView ? t('展开') : t('收起')" @click="toggleCollapse">
        <AppIcon :name="collapsedView ? 'chevron-right' : 'layout-sidebar'" :size="15" />
      </AppButton>
    </div>

    <AppButton variant="secondary" class="new-chat" @click="newChat">
      <AppIcon name="plus" :size="15" />
      <span v-if="!collapsedView">{{ t('新会话') }}</span>
    </AppButton>

    <nav class="main-nav">
      <router-link
        v-for="n in mainNav"
        :key="n.name"
        :to="n.path"
        class="nav-item"
        :class="{ active: isActive(n.path) }"
      >
        <AppIcon :name="n.icon" :size="17" />
        <span v-if="!collapsedView" class="lbl">{{ n.title }}</span>
        <span
          v-if="n.name === 'inbox' && unreadCount"
          class="nav-badge"
          :class="{ dot: collapsedView }"
          :title="t('{0} 条未读', [unreadCount])"
        >{{ collapsedView ? '' : unreadCount > 99 ? '99+' : unreadCount }}</span>
      </router-link>
    </nav>

    <div v-if="!collapsedView" class="workspace">
      <div class="ws-head">
        <span class="ws-title">{{ t('工作区') }}</span>
        <div class="ws-actions">
          <AppButton variant="icon" :title="t('全局搜索 (⌘K)')" @click="openPalette()">
            <AppIcon name="search" :size="13" />
          </AppButton>
          <AppButton
            variant="icon"
            :title="sortMode === 'updated' ? t('按名称排序') : t('按最近更新排序')"
            @click="sortMode = sortMode === 'updated' ? 'name' : 'updated'"
          >
            <AppIcon name="sort" :size="13" />
          </AppButton>
          <AppButton variant="icon" :title="t('新建项目')" @click="router.push('/projects')">
            <AppIcon name="folder-plus" :size="13" />
          </AppButton>
        </div>
      </div>
      <ul class="ws-list">
        <template v-for="p in sortedProjects" :key="p.id">
          <li :class="{ active: p.id === activeProjectId }" @click="setActiveProject(p.id)">
            <!-- 展开箭头：有目录的项目才有运行记录可展开。 -->
            <AppButton
              v-if="p.path"
              variant="icon"
              class="ws-caret"
              :class="{ open: expanded.has(p.id) }"
              :title="expanded.has(p.id) ? t('收起运行记录') : t('展开运行记录')"
              @click.stop="toggleExpand(p.id)"
            >
              <AppIcon name="chevron-right" :size="12" />
            </AppButton>
            <AppIcon v-else class="ws-caret-spacer" name="folder" :size="14" />
            <span class="ws-name">{{ p.name }}</span>
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
            <span class="ws-time">{{ timeAgo(p.updated_at) }}</span>
          </li>
          <!-- 该项目的历史运行记录：journal 按 session_open 分段，默认 5 条 + 加载更多。 -->
          <li v-if="p.path && expanded.has(p.id)" class="ws-runs">
            <RunHistory :cwd="p.path" @open="openRecord(p, $event)" />
          </li>
        </template>
        <li v-if="!projects.length" class="ws-empty">{{ t('暂无项目') }}</li>
      </ul>
    </div>

    <div v-else class="main-nav compact">
      <AppButton variant="icon" :title="t('工作区')" @click="router.push('/projects')">
        <AppIcon name="folder" :size="17" />
      </AppButton>
    </div>

    <div class="foot">
      <UsageCard v-if="!collapsedView" />
      <div class="foot-actions">
        <ThemeToggle :collapsed="collapsedView" />
        <AppButton variant="text" class="settings" :class="{ collapsed: collapsedView }" :title="t('设置')" @click="router.push('/settings')">
          <AppIcon name="settings" :size="15" />
          <span v-if="!collapsedView">{{ t('设置') }}</span>
        </AppButton>
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
