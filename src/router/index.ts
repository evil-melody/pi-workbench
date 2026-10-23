import { createRouter, createWebHashHistory } from 'vue-router'
import ChatView from '@/views/ChatView.vue'
import ProjectsView from '@/views/ProjectsView.vue'
import ProjectWorkspace from '@/views/ProjectWorkspace.vue'
import LibraryPanel from '@/components/panels/LibraryPanel.vue'
import CapabilitiesView from '@/views/CapabilitiesView.vue'
import PluginsView from '@/views/PluginsView.vue'
import SettingsView from '@/views/SettingsView.vue'
import NotFoundView from '@/views/NotFoundView.vue'

const routes = [
  { path: '/', redirect: '/chat' },
  {
    path: '/chat',
    name: 'chat',
    component: ChatView,
    meta: { title: '对话', icon: 'chat' },
  },
  {
    path: '/projects',
    name: 'projects',
    component: ProjectsView,
    meta: { title: '项目', icon: 'share-network' },
  },
  {
    path: '/projects/:id',
    name: 'project-workspace',
    component: ProjectWorkspace,
    meta: { title: '项目工作台', icon: 'folder' },
  },
  {
    path: '/library',
    name: 'library',
    component: LibraryPanel,
    meta: { title: '资料库', icon: 'book' },
  },
  {
    path: '/capabilities',
    name: 'capabilities',
    component: CapabilitiesView,
    meta: { title: '专家 · 技能 · 连接器', icon: 'grid' },
  },
  {
    path: '/plugins',
    name: 'plugins',
    component: PluginsView,
    meta: { title: '插件', icon: 'puzzle' },
  },
  {
    path: '/settings',
    name: 'settings',
    component: SettingsView,
    meta: { title: '设置', icon: 'settings' },
  },
  /**
   * 运行层能力不单开导航：这四个路径保留为兼容入口，
   * 一律重定向到承载它们的既有菜单（能力中心 / 资料库）并带上目标 tab。
   */
  { path: '/agent-ops/teams', redirect: { path: '/capabilities', query: { tab: 'team' } } },
  { path: '/agent-ops/memory', redirect: { path: '/library', query: { view: 'memory' } } },
  { path: '/agent-ops/skills', redirect: { path: '/capabilities', query: { tab: 'market' } } },
  { path: '/agent-ops/browser', redirect: { path: '/capabilities', query: { tab: 'browser' } } },
  /**
   * AUDIT-006：catch-all 必须放在最后——vue-router 按序匹配，
   * 提前会把上面的业务路径全吞掉。没有它，未知路径白屏无兜底。
   */
  { path: '/:pathMatch(.*)*', name: 'not-found', component: NotFoundView },
]

export default createRouter({
  history: createWebHashHistory(),
  routes,
})
