<script setup lang="ts">
import { t } from '@/i18n'
/**
 * 能力中心 —— 专家 / 技能 / 连接器 / 团队 / 技能池 / 浏览器 的统一入口。
 *
 * 顶部：专家 / 技能 / 连接器 胶囊 tab + 搜索 + 右侧操作区
 * 中间：专家是「左列表 + 右编辑器」，技能是卡片网格，连接器是独立的实例管理面板
 *
 * 数据来自 skills_list / experts_list；连接器走 connectors_* 命令（见 useConnectors）。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { onTablistKeydown } from '@/composables/useTablist'
import { invoke } from '@tauri-apps/api/core'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppCheckbox from '@/components/ui/AppCheckbox.vue'
import ExpertDraftEditor from '@/components/experts/ExpertDraftEditor.vue'
import ConnectorPanel from '@/components/connectors/ConnectorPanel.vue'
import TeamsView from '@/views/TeamsView.vue'
import SkillPoolView from '@/views/SkillPoolView.vue'
import BrowserView from '@/views/BrowserView.vue'
import { skillsInstall, skillsInstallFromUrl, skillsUninstall } from '@/composables/useSkills'
import { toolsActivate, toolsList } from '@/composables/useTools'
import { describeConnectorError } from '@/composables/useConnectors'
import { expertsList, type ExpertSummary } from '@/composables/useExperts'
import { PI_SESSION_ID } from '@/composables/useProject'

type Tab = 'expert' | 'skill' | 'connector' | 'team' | 'market' | 'browser'
type SubTab = 'local' | 'hub'

interface SkillEntry {
  name: string
  description: string
  kind: string
  path: string
  via: string
  scope: string
  /** local | url | kernel */
  origin: string
  version?: string
  author?: string
}

interface Row {
  key: string
  name: string
  sub: string
  desc: string
  version: string
  source: string
  installed: boolean
  color: string
  roleId?: string
  origin?: string
}

const TABS = computed<{ key: Tab; label: string; icon: string }[]>(() => [
  { key: 'expert', label: t('专家'), icon: 'sparkles' },
  { key: 'skill', label: t('技能'), icon: 'puzzle' },
  { key: 'connector', label: t('连接器'), icon: 'plug' },
  { key: 'team', label: t('团队'), icon: 'users' },
  { key: 'market', label: t('市场池'), icon: 'layers' },
  { key: 'browser', label: t('浏览器'), icon: 'monitor' },
])

const PALETTE = ['#ef4444', '#f97316', '#f59e0b', '#84cc16', '#10b981', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#ec4899']

const route = useRoute()

/** 只接受已知 tab 名，非法 query 一律回落到默认页，避免出现空白能力中心。 */
const TAB_KEYS: Tab[] = ['expert', 'skill', 'connector', 'team', 'market', 'browser']
function tabFromQuery(): Tab {
  const q = route.query.tab
  const value = Array.isArray(q) ? q[0] : q
  return TAB_KEYS.includes(value as Tab) ? (value as Tab) : 'skill'
}

const tab = ref<Tab>(tabFromQuery())
const subTab = ref<SubTab>('local')
const hubNotice = ref('')
const keyword = ref('')
const skills = ref<SkillEntry[]>([])
const connectorCount = ref(0)
const busy = ref(false)
const error = ref('')

const activeTools = ref<string[]>([])
const installing = ref(false)
const showInstallModal = ref(false)
/** path：本地 SKILL.md 路径；url：远端 SKILL.md 直链。 */
const installMode = ref<'path' | 'url'>('path')
const installPath = ref('')
const installProjectScope = ref(false)
const installError = ref('')
const installSuccess = ref('')

function hashColor(name: string) {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]
}

function firstChar(name: string) {
  for (const c of name) {
    if (/\p{L}/u.test(c)) return c.toUpperCase()
  }
  return name.slice(0, 1).toUpperCase() || '?'
}

/**
 * 内嵌 tab：内容来自运行层视图（团队 / 市场池 / 浏览器），
 * 它们各自带工具栏，外层不再重复渲染「刷新 / 新建」等能力中心按钮。
 */
const isEmbeddedTab = computed(
  () => tab.value === 'team' || tab.value === 'market' || tab.value === 'browser',
)

const installedCount = computed(() => {
  if (tab.value === 'expert') return expertItems.value.length
  if (tab.value === 'skill') return skills.value.length
  if (tab.value === 'connector') return connectorCount.value
  return 0
})

/** SkillHub 子页：不内置市场服务端，因此给一条真实可用的「直链安装」链路而不是假列表。 */
const hubFromUrlCount = computed(() => skills.value.filter((s) => s.origin === 'url').length)

/** 专家域：草稿列表是专家 tab 的左侧栏，选中项交给编辑器。 */
const expertItems = ref<ExpertSummary[]>([])
const activeExpert = ref<string | null>(null)
const expertViewError = ref('')

const rows = computed<Row[]>(() => {
  if (subTab.value === 'hub') return []
  if (tab.value === 'expert' || tab.value === 'connector') return []
  const k = keyword.value.trim().toLowerCase()
  const match = (text: string) => !k || text.toLowerCase().includes(k)
  return skills.value
    .filter((s) => match(s.name) || match(s.description))
    .map((s) => ({
      key: s.name,
      name: s.name,
      sub: s.kind,
      desc: s.description || t('（暂无简介）'),
      version: s.version || t('未知'),
      source: s.author || s.via || t('本地'),
      installed: true,
      color: hashColor(s.name),
      origin: s.origin,
    }))
})

const title = computed(() => {
  if (tab.value === 'expert') return t('专家市场')
  if (tab.value === 'connector') return t('连接器')
  if (tab.value === 'team') return t('多智能体团队')
  if (tab.value === 'market') return t('技能市场池')
  if (tab.value === 'browser') return t('浏览器自动化')
  return t('技能市场')
})

async function load() {
  busy.value = true
  error.value = ''
  try {
    skills.value = await invoke<SkillEntry[]>('skills_list', { root: null }).catch(() => [])
  } catch {
    skills.value = []
  }
  try {
    const ts = await toolsList().catch(() => ({ active: [] }))
    activeTools.value = ts.active
  } catch {
    activeTools.value = []
  }
  try {
    expertItems.value = await expertsList()
    if (activeExpert.value && !expertItems.value.some((e) => e.id === activeExpert.value)) {
      activeExpert.value = null
    }
    expertViewError.value = ''
  } catch (e: any) {
    expertItems.value = []
    expertViewError.value = String(e?.message ?? e)
  }
  busy.value = false
}

const expertDraftCount = computed(() => expertItems.value.length)
const publishedExpertCount = computed(() => expertItems.value.filter((e) => e.published).length)

function pickExpert(id: string) {
  activeExpert.value = id
}

/** 新建专家：只登记 id 并打开编辑器；草稿真正落盘发生在编辑器里点保存之后。 */
const showCreateExpert = ref(false)
const newExpertId = ref('')
const createExpertError = ref('')

function openCreateExpert() {
  newExpertId.value = ''
  createExpertError.value = ''
  showCreateExpert.value = true
}

function confirmCreateExpert() {
  const raw = newExpertId.value.trim()
  if (!raw) return
  const id = raw.toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/^-+|-+$/g, '')
  if (!id) {
    createExpertError.value = t('id 至少需要一个英文字母、数字或连字符')
    return
  }
  if (expertItems.value.some((e) => e.id === id)) {
    // 已存在就直接切过去，避免用同一个 id 造出第二份草稿。
    activeExpert.value = id
    showCreateExpert.value = false
    return
  }
  activeExpert.value = id
  showCreateExpert.value = false
}

/** 编辑器保存后同步左侧列表：修订号变了要立刻反映出来。 */
function onExpertSaved() {
  void load()
}

function onExpertPublished() {
  void load()
}

function onConnectorNotice(text: string) {
  hubNotice.value = text
  error.value = ''
}

function onConnectorError(e: unknown) {
  error.value = describeConnectorError(e, t('连接器操作失败'))
  hubNotice.value = ''
}

watch(tab, (next) => {
  if (next === 'expert' || next === 'skill') void load()
})

// 兼容来自 /agent-ops/* 的重定向：query 变化时同步切换 tab。
watch(
  () => route.query.tab,
  (q) => {
    const value = Array.isArray(q) ? q[0] : q
    if (value && TAB_KEYS.includes(value as Tab)) tab.value = value as Tab
  },
)

async function installSkill() {
  const value = installPath.value.trim()
  if (!value) return
  installing.value = true
  installError.value = ''
  installSuccess.value = ''
  try {
    const res =
      installMode.value === 'url'
        ? await skillsInstallFromUrl(value, undefined, installProjectScope.value)
        : await skillsInstall(value, undefined, installProjectScope.value)
    installSuccess.value = t('「{0}」已安装{1}{2}', [res.entry.name, res.entry.origin === 'url' ? t('（来自远端链接）') : '', res.needs_restart ? t('，重启内核后生效') : ''])
    hubNotice.value = installSuccess.value
    installPath.value = ''
    await load()
  } catch (e: any) {
    installError.value = String(e?.message ?? e)
  }
  installing.value = false
}

function openInstall(mode: 'path' | 'url') {
  installMode.value = mode
  installError.value = ''
  installSuccess.value = ''
  showInstallModal.value = true
}

/** 卸载确认（AUDIT-014②）：window.confirm 是原生阻断框，且样式/焦点不可控，
 *  改为 AppModal 确认流——pendingUninstall 非空即打开。 */
const pendingUninstall = ref<string | null>(null)

function uninstallSkill(name: string) {
  pendingUninstall.value = name
}

async function confirmUninstall() {
  const name = pendingUninstall.value
  if (!name) return
  pendingUninstall.value = null
  try {
    await skillsUninstall(name)
    hubNotice.value = t('「{0}」已卸载，重启内核后生效', [name])
    error.value = ''
  } catch (e: any) {
    error.value = String(e?.message ?? e)
    hubNotice.value = ''
  }
  await load()
}

function switchSub(next: SubTab) {
  subTab.value = next
  hubNotice.value = ''
  if (next === 'hub') void load()
}

onMounted(load)
</script>

<template>
  <section class="wd-market">
    <header class="market-header">
      <nav class="market-tabs" role="tablist" :aria-label="t('能力分类')" @keydown="onTablistKeydown">
        <AppButton
          v-for="t in TABS"
          :key="t.key"
          variant="tab"
          role="tab"
          :aria-selected="t.key === tab"
          :tabindex="t.key === tab ? 0 : -1"
          class="market-tab"
          :class="{ active: t.key === tab }"
          @click="tab = t.key"
        >
          <AppIcon :name="t.icon" :size="14" />
          {{ t.label }}
        </AppButton>
      </nav>

      <div class="market-tools">
        <AppInput v-if="tab === 'skill'" v-model="keyword" :placeholder="t('搜索技能')" />
        <span v-if="tab === 'expert' || tab === 'skill' || tab === 'connector'" class="installed-badge">
          {{ tab === 'expert'
              ? t('草稿 {0} · 已发布 {1}', [expertDraftCount, publishedExpertCount])
              : t('我安装的 {0}', [installedCount]) }}
        </span>
        <AppButton v-if="!isEmbeddedTab" variant="secondary" class="tool-btn" @click="load">{{ t('刷新') }}</AppButton>
        <AppButton v-if="tab === 'expert'" variant="primary" class="tool-btn primary" @click="openCreateExpert">{{ t('+ 新建专家') }}</AppButton>
        <AppButton
          v-else-if="tab === 'skill'"
          variant="primary"
          class="tool-btn primary"
          @click="openInstall(subTab === 'hub' ? 'url' : 'path')"
        >
          {{ subTab === 'hub' ? t('+ 从链接安装') : t('+ 添加技能') }}
        </AppButton>
      </div>
    </header>

    <!-- 内嵌 tab 由融合视图自带「标题 + 说明」，外层不再叠加同名标题。 -->
    <h1 v-if="!isEmbeddedTab" class="market-title">{{ title }}</h1>

    <nav v-if="tab === 'skill'" class="sub-tabs" role="tablist" :aria-label="t('技能来源')" @keydown="onTablistKeydown">
      <AppButton
        variant="tab"
        role="tab"
        :aria-selected="subTab === 'local'"
        :tabindex="subTab === 'local' ? 0 : -1"
        class="sub-tab"
        :class="{ active: subTab === 'local' }"
        @click="switchSub('local')"
      >{{ t('本地技能') }}</AppButton>
      <AppButton
        variant="tab"
        role="tab"
        :aria-selected="subTab === 'hub'"
        :tabindex="subTab === 'hub' ? 0 : -1"
        class="sub-tab"
        :class="{ active: subTab === 'hub' }"
        @click="switchSub('hub')"
      >
        SkillHub
      </AppButton>
    </nav>

    <!-- 团队：多智能体团队编排 -->
    <section v-if="tab === 'team'" class="agent-ops-embedded-shell">
      <TeamsView embedded />
    </section>

    <!-- 技能池 / 共享市场 -->
    <section v-else-if="tab === 'market'" class="agent-ops-embedded-shell">
      <SkillPoolView embedded />
    </section>

    <!-- 浏览器自动化：与对话右侧「智能体浏览器」同源，此处提供会话与直达入口 -->
    <section v-else-if="tab === 'browser'" class="agent-ops-embedded-shell">
      <BrowserView embedded />
    </section>

    <!-- 连接器：实例管理面板（列表 + 启停 + 编辑 + 会话级选择） -->
    <section v-else-if="tab === 'connector'" class="connector-shell">
      <ConnectorPanel
        :session-id="PI_SESSION_ID"
        @count="connectorCount = $event"
        @notice="onConnectorNotice"
        @error="onConnectorError"
      />
    </section>

    <!-- 专家：左列表 + 右编辑器。没有 market 服务端，给的是可落盘的草稿链路。 -->
    <section v-else-if="tab === 'expert'" class="expert-shell">
      <aside class="expert-list">
        <div class="expert-list-head">
          <span>{{ t('我的专家') }}</span>
          <AppButton variant="text" class="ed-mini" @click="openCreateExpert">{{ t('+ 新建') }}</AppButton>
        </div>
        <AppButton v-if="!expertItems.length" variant="card" class="expert-blank" @click="openCreateExpert">
          <AppIcon name="plus" :size="16" />
          <span>{{ t('还没有专家，点这里新建') }}</span>
        </AppButton>
        <template v-else>
          <AppButton
            v-for="e in expertItems"
            :key="e.id"
            variant="card"
            class="expert-item"
            :class="{ active: e.id === activeExpert }"
            :aria-current="e.id === activeExpert ? 'true' : undefined"
            @click="pickExpert(e.id)"
          >
            <span class="expert-item-top">
              <strong>{{ e.name || e.id }}</strong>
              <AppIcon v-if="e.published" name="check" :size="13" class="expert-pub" />
            </span>
            <span class="expert-item-desc">{{ e.description || t('（暂无简介）') }}</span>
            <span class="expert-item-meta">
              <span v-if="e.published" class="tag-published">{{ t('已发布') }}</span>
              <span>{{ t('修订 #{0}', [e.draft_revision]) }}</span>
            </span>
          </AppButton>
        </template>
        <p v-if="expertViewError" class="expert-list-err">{{ expertViewError }}</p>
      </aside>

      <div class="expert-main">
        <ExpertDraftEditor
          v-if="activeExpert"
          :expert-id="activeExpert"
          @saved="onExpertSaved"
          @published="onExpertPublished"
        />
        <div v-else class="expert-main-blank">
          <strong>{{ busy ? t('正在读取专家目录…') : t('未选中专家') }}</strong>
          <span class="muted">{{ t('专家由「角色定位 / 工作方法 / 行为边界 / 交付物」四段人格拼装， 保存为草稿后需一次显式确认才会发布到 Pi 的角色文件。') }}</span>
        </div>
      </div>
    </section>

    <template v-else>
      <div class="market-counts">
        {{ busy ? t('正在读取能力目录…') : hubNotice || error || t('共 {0} 个技能', [rows.length]) }}
      </div>

      <!-- SkillHub：不内置市场服务端，给一条真实可用的直链安装链路 -->
      <section v-if="subTab === 'hub'" class="hub-panel">
        <h2>{{ t('从任意 SKILL.md 直链安装') }}</h2>
        <p class="hub-lead">{{ t('本应用不内置远端技能市场服务端：任何能给出 SKILL.md 直链的来源（raw 链接、自建市场、 gist）都能在此一键安装。下载后会与本地导入走同一套校验与落盘规则，装到') }}<code>{{ t('skills/<名称>/SKILL.md') }}</code>{{ t('，内核重启后生效。') }}</p>
        <div class="hub-actions">
          <AppButton variant="primary" class="tool-btn primary" @click="openInstall('url')">{{ t('+ 从链接安装') }}</AppButton>
          <span class="hub-stat">{{ t('已通过链接安装 {0} 个，本地导入 {1} 个', [hubFromUrlCount, skills.filter((s) => s.origin === 'local').length]) }}</span>
        </div>
        <p v-if="hubNotice" class="hub-notice">{{ hubNotice }}</p>
      </section>

      <div v-if="!rows.length" class="market-empty">
        <div class="empty-icon"><AppIcon name="puzzle" :size="36" /></div>
        <strong>{{ keyword ? t('没有匹配的结果') : t('还没有技能') }}</strong>
        <span class="muted">
          {{ keyword ? t('保留搜索词，可清除后重试。') : t('技能是本地 SKILL.md 文件，可从链接安装或放入用户级技能目录后刷新。') }}
        </span>
        <div class="empty-actions">
          <AppButton variant="primary" class="tool-btn primary" @click="openInstall(subTab === 'hub' ? 'url' : 'path')">
            {{ subTab === 'hub' ? t('从链接安装') : t('添加技能') }}
          </AppButton>
          <AppButton variant="secondary" class="tool-btn" @click="load">{{ t('刷新') }}</AppButton>
        </div>
      </div>

      <div v-else class="market-grid">
        <article
          v-for="r in rows"
          :key="r.key"
          class="market-card"
        >
          <AppButton
            v-if="subTab === 'local'"
            variant="icon"
            class="card-install"
            :title="t('卸载该技能')"
            @click.stop="uninstallSkill(r.name)"
          >
            <AppIcon name="trash" :size="15" />
          </AppButton>
          <span v-else class="card-install-state">
            <AppIcon name="check" :size="14" />
          </span>
          <div class="card-top">
            <!-- 功能性动态值（哈希色），豁免纯样式抽离铁律：CSS 变量传色值 -->
            <span class="card-icon" :style="{ '--card-bg': r.color }">{{ firstChar(r.name) }}</span>
            <span class="card-title">
              <strong :title="r.name">{{ r.name }}</strong>
              <span class="card-sub">{{ r.sub }}</span>
            </span>
          </div>
          <p class="card-desc">{{ r.desc }}</p>
          <div class="card-foot">
            <span v-if="r.origin === 'url'" class="meta origin-url">{{ t('来自链接') }}</span>
            <span v-if="r.version" class="meta">{{ t('版本 {0}', [r.version]) }}</span>
            <span v-if="r.source" class="meta">{{ t('来源 {0}', [r.source]) }}</span>
          </div>
        </article>
      </div>
    </template>

    <AppModal
      v-model:open="showCreateExpert"
      :title="t('新建专家')"
      size="sm"
      @close="showCreateExpert = false"
    >
      <div class="install-form">
        <label>
          <span>{{ t('专家 id') }}</span>
          <AppInput
            v-model="newExpertId"
            :placeholder="t('例如：code-review（英文、唯一标识）')"
            mono
            @keydown.enter="confirmCreateExpert"
          />
        </label>
        <p v-if="createExpertError" class="form-error">{{ createExpertError }}</p>
        <p class="form-hint">{{ t('只登记 id 并打开编辑器，此时还没有落盘；在编辑器里点「保存草稿」后才会写入， 再走一次显式确认才会发布到 Pi 的角色文件。') }}</p>
      </div>
      <template #footer>
        <AppButton variant="secondary" class="tool-btn" @click="showCreateExpert = false">{{ t('取消') }}</AppButton>
        <AppButton
          variant="primary"
          class="tool-btn primary"
          :disabled="!newExpertId.trim()"
          @click="confirmCreateExpert"
        >{{ t('打开编辑器') }}</AppButton>
      </template>
    </AppModal>

    <AppModal
      v-model:open="showInstallModal"
      :title="installMode === 'url' ? t('从链接安装技能') : t('添加技能')"
      size="md"
      @close="showInstallModal = false"
    >
      <div class="install-form">
        <label>
          <span>{{ installMode === 'url' ? t('SKILL.md 直链') : t('技能路径') }}</span>
          <AppInput
            v-model="installPath"
            :placeholder="installMode === 'url' ? 'https://…/SKILL.md' : t('粘贴 SKILL.md 或技能目录的绝对路径')"
            mono
          />
        </label>
        <label class="scope-check">
          <AppCheckbox
            v-model="installProjectScope"
            :label="t('安装到当前项目（无项目时落到用户级）')"
          />
        </label>
        <p v-if="installError" class="form-error">{{ installError }}</p>
        <p v-if="installSuccess" class="form-success">{{ installSuccess }}</p>
        <p class="form-hint">
          {{ installMode === 'url'
              ? t('只接受 http/https 直链，单文件上限 1 MiB；下载后会校验 frontmatter，不合法不会落盘。')
              : t('路径需指向 SKILL.md 文件或包含 SKILL.md 的目录。') }}
        </p>
      </div>
      <template #footer>
        <AppButton variant="secondary" class="tool-btn" @click="showInstallModal = false">{{ t('取消') }}</AppButton>
        <AppButton variant="primary" class="tool-btn primary" :disabled="installing || !installPath.trim()" @click="installSkill">
          {{ installing ? t('安装中…') : t('安装') }}
        </AppButton>
      </template>
    </AppModal>

    <!-- AUDIT-014②：卸载确认（原 window.confirm 原生阻断框） -->
    <AppModal
      :open="!!pendingUninstall"
      :title="t('卸载技能')"
      size="sm"
      @close="pendingUninstall = null"
    >
      <p class="form-hint">{{ t('确定卸载技能「{0}」？将删除其 SKILL.md，内核重启后生效。此操作不可撤销。', [pendingUninstall]) }}</p>
      <template #footer>
        <AppButton variant="secondary" class="tool-btn" @click="pendingUninstall = null">{{ t('取消') }}</AppButton>
        <AppButton variant="danger" class="tool-btn danger" @click="confirmUninstall">{{ t('确认卸载') }}</AppButton>
      </template>
    </AppModal>
  </section>
</template>

<style src="./CapabilitiesView.css" scoped></style>
