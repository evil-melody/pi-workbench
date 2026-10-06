<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { invoke } from '@tauri-apps/api/core'
import AppIcon from '@/components/ui/AppIcon.vue'
import ThemeToggle from './ThemeToggle.vue'
import UsageCard from './UsageCard.vue'
// 活动项目是共享状态：这里切了，对话页的 watcher 会跟着换工作目录。
import { activateProject, activeProjectId, loadActiveProject } from '@/composables/useProject'
import { startNewSession } from '@/composables/useChatSession'
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
        <li
          v-for="p in sortedProjects"
          :key="p.id"
          :class="{ active: p.id === activeProjectId }"
          @click="setActiveProject(p.id)"
        >
          <AppIcon name="folder" :size="14" />
          <span class="ws-name">{{ p.name }}</span>
          <button
            class="ws-open"
            title="打开项目工作台（配置 / 文件 / 终端 / 浏览器）"
            @click.stop="openWorkspace(p.id)"
          >
            <AppIcon name="external" :size="12" />
          </button>
          <span class="ws-time">{{ relativeTime(p.updated_at) }}</span>
        </li>
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
</template>

<style src="./Sidebar.css" scoped></style>
