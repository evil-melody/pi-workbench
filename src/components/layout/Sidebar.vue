<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { invoke } from '@tauri-apps/api/core'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppInput from '@/components/ui/AppInput.vue'
import ThemeToggle from './ThemeToggle.vue'
import UsageCard from './UsageCard.vue'
import RunHistory from '@/components/chat/RunHistory.vue'
// 活动项目是共享状态：这里切了，对话页的 watcher 会跟着换工作目录。
import { activateProject, activeProjectId, loadActiveProject } from '@/composables/useProject'
import { startNewSession } from '@/composables/useChatSession'
import { pendingReplayIndex } from '@/composables/useReplay'
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

const mainNav = [
  { name: 'plugins', path: '/plugins', title: '插件', icon: 'puzzle' },
  { name: 'projects', path: '/projects', title: '项目', icon: 'share-network' },
  { name: 'capabilities', path: '/capabilities', title: '专家 · 技能 · 连接器', icon: 'grid' },
  { name: 'library', path: '/library', title: '资料库', icon: 'book' },
]

function isActive(path: string) {
  return route.path.startsWith(path)
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

function openProjectMenu(p: Project, el: Event) {
  const anchor = (el.currentTarget as HTMLElement).closest('li') as HTMLElement | null
  const r = anchor?.getBoundingClientRect()
  if (!r) return
  const width = 180
  const left = Math.min(Math.max(8, r.right - width), window.innerWidth - width - 8)
  projectMenu.value = { project: p, style: { left: `${left}px`, top: `${r.bottom + 6}px` } }
}

function closeProjectMenu() {
  projectMenu.value = null
}

function onDocClick(e: MouseEvent) {
  if (projectMenu.value && !(e.target as HTMLElement).closest('.ctx-menu')) closeProjectMenu()
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') closeProjectMenu()
}

/** 在系统文件管理器里显示项目目录（后端 reveal_item_in_dir）。 */
async function revealProject(p: Project) {
  closeProjectMenu()
  await invoke('project_reveal', { id: p.id }).catch((e) =>
    console.error('打开文件夹失败', e),
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

function relativeTime(ts?: number) {
  if (!ts) return ''
  const diff = Date.now() - ts
  const min = 60_000
  const hour = 60 * min
  const day = 24 * hour
  if (diff < min) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  const days = Math.floor(diff / day)
  if (days < 30) return `${days} 天前`
  return new Date(ts).toLocaleDateString()
}

onMounted(() => {
  const saved = localStorage.getItem('pi-workbench:sidebar-collapsed')
  if (saved === '1') collapsed.value = true
  refreshProjects()
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKey)
})

defineExpose({ refreshProjects })
</script>

<template>
  <aside class="sidebar" :class="{ collapsed }">
    <div class="brand">
      <div class="mark">
        <img :src="mascotUrl" alt="" />
      </div>
      <div v-if="!collapsed" class="btext">
        <div class="bname">Pi Workbench</div>
      </div>
      <button class="collapse" :title="collapsed ? '展开' : '收起'" @click="toggleCollapse">
        <AppIcon :name="collapsed ? 'chevron-right' : 'layout-sidebar'" :size="15" />
      </button>
    </div>

    <button class="new-chat" @click="newChat">
      <AppIcon name="plus" :size="15" />
      <span v-if="!collapsed">新会话</span>
    </button>

    <nav class="main-nav">
      <router-link
        v-for="n in mainNav"
        :key="n.name"
        :to="n.path"
        class="nav-item"
        :class="{ active: isActive(n.path) }"
      >
        <AppIcon :name="n.icon" :size="17" />
        <span v-if="!collapsed" class="lbl">{{ n.title }}</span>
      </router-link>
    </nav>

    <div v-if="!collapsed" class="workspace">
      <div class="ws-head">
        <span class="ws-title">工作区</span>
        <div class="ws-actions">
          <button title="搜索项目（在项目页）" @click="router.push('/projects')">
            <AppIcon name="search" :size="13" />
          </button>
          <button
            :title="sortMode === 'updated' ? '按名称排序' : '按最近更新排序'"
            @click="sortMode = sortMode === 'updated' ? 'name' : 'updated'"
          >
            <AppIcon name="sort" :size="13" />
          </button>
          <button title="新建项目" @click="router.push('/projects')">
            <AppIcon name="folder-plus" :size="13" />
          </button>
        </div>
      </div>
      <ul class="ws-list">
        <template v-for="p in sortedProjects" :key="p.id">
          <li :class="{ active: p.id === activeProjectId }" @click="setActiveProject(p.id)">
            <!-- 展开箭头：有目录的项目才有运行记录可展开。 -->
            <button
              v-if="p.path"
              class="ws-caret"
              :class="{ open: expanded.has(p.id) }"
              :title="expanded.has(p.id) ? '收起运行记录' : '展开运行记录'"
              @click.stop="toggleExpand(p.id)"
            >
              <AppIcon name="chevron-right" :size="12" />
            </button>
            <AppIcon v-else class="ws-caret-spacer" name="folder" :size="14" />
            <span class="ws-name">{{ p.name }}</span>
            <button
              class="ws-more"
              title="更多操作"
              @click.stop="openProjectMenu(p, $event)"
            >
              <AppIcon name="more-horizontal" :size="14" />
            </button>
            <button
              class="ws-open"
              title="打开项目工作台（配置 / 文件 / 终端 / 浏览器）"
              @click.stop="openWorkspace(p.id)"
            >
              <AppIcon name="external" :size="12" />
            </button>
            <span class="ws-time">{{ relativeTime(p.updated_at) }}</span>
          </li>
          <!-- 该项目的历史运行记录：journal 按 session_open 分段，默认 5 条 + 加载更多。 -->
          <li v-if="p.path && expanded.has(p.id)" class="ws-runs">
            <RunHistory :cwd="p.path" @open="openRecord(p, $event)" />
          </li>
        </template>
        <li v-if="!projects.length" class="ws-empty">暂无项目</li>
      </ul>
    </div>

    <div v-else class="main-nav compact">
      <button title="工作区" @click="router.push('/projects')">
        <AppIcon name="folder" :size="17" />
      </button>
    </div>

    <div class="foot">
      <UsageCard v-if="!collapsed" />
      <div class="foot-actions">
        <ThemeToggle :collapsed="collapsed" />
        <button class="settings" :class="{ collapsed }" title="设置" @click="router.push('/settings')">
          <AppIcon name="settings" :size="15" />
          <span v-if="!collapsed">设置</span>
        </button>
      </div>
    </div>

    </aside>

    <!-- 项目行「···」菜单：Teleport 到 body，公共 ctx-menu 样式 -->
    <Teleport to="body">
      <div v-if="projectMenu" class="ctx-menu" :style="projectMenu.style" role="menu">
        <button
          v-if="projectMenu.project.path"
          type="button"
          class="ctx-menu-item"
          role="menuitem"
          @click="revealProject(projectMenu.project)"
        >
          <AppIcon name="folder-open" :size="15" />
          <span>打开文件夹</span>
        </button>
        <button
          type="button"
          class="ctx-menu-item"
          role="menuitem"
          @click="startRename(projectMenu.project)"
        >
          <AppIcon name="edit" :size="15" />
          <span>重命名</span>
        </button>
        <button
          type="button"
          class="ctx-menu-item danger"
          role="menuitem"
          @click="startRemove(projectMenu.project)"
        >
          <AppIcon name="trash" :size="15" />
          <span>从列表中移除</span>
        </button>
      </div>
    </Teleport>

    <!-- 重命名 -->
    <AppModal :open="renameOpen" title="重命名项目" size="sm" @close="renameOpen = false">
      <label class="ws-dialog-row">
        <span>新名称</span>
        <AppInput v-model="renameName" :placeholder="renameTarget?.name ?? ''" @keydown.enter="submitRename" />
      </label>
      <template #footer>
        <button class="ws-btn" @click="renameOpen = false">取消</button>
        <button class="ws-btn primary" @click="submitRename">保存</button>
      </template>
    </AppModal>

    <!-- 从列表中移除：只摘项目引用，目录里的文件不动 -->
    <AppModal :open="removeOpen" title="从列表中移除项目" size="sm" @close="removeOpen = false">
      <p class="ws-dialog-text">
        将从工作区列表移除「{{ removeTarget?.name }}」。绑定的目录与里面的文件不会被删除。
      </p>
      <template #footer>
        <button class="ws-btn" @click="removeOpen = false">取消</button>
        <button class="ws-btn danger" @click="submitRemove">移除</button>
      </template>
    </AppModal>
</template>

<style src="@/components/ui/ContextMenu.css" scoped></style>
<style src="./Sidebar.css" scoped></style>
