<script setup lang="ts">
import { t } from '@/i18n'
/**
 * 项目工作台 —— 覆盖 `ProjectService` 的全部能力面：
 *   get / updateConfig（修订 + token 预算）/ addWorkItem / updateWorkItem /
 *   addAsset / removeAsset / linkTask / taskContext。
 *
 * 与内核（Pi）融合：保存配置与绑定会话任务后，Pi 每轮可从
 * `project_task_context` 拿到「项目 + 配置 + 本次会话引用的能力」，
 * 从而在项目上下文中工作，而不是只在空白会话里跑。
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { invoke } from '@tauri-apps/api/core'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppButton from '@/components/ui/AppButton.vue'
import ModeSwitcher from '@/components/chat/ModeSwitcher.vue'
import { thinkingLevel, setThinkingMode } from '@/composables/useThinkingMode'
import { onTablistKeydown } from '@/composables/useTablist'
import AppInput from '@/components/ui/AppInput.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import type { SelectOption } from '@/components/ui/AppSelect.vue'
import AppTextarea from '@/components/ui/AppTextarea.vue'
import FilesWorkspace from '@/components/fs/FilesWorkspace.vue'
import TerminalPanel from '@/components/terminal/TerminalPanel.vue'
import AgentBrowserPane from '@/components/chat/AgentBrowserPane.vue'
import { PICK_TIMEOUT_NOTE, pickDirectoryGuarded } from '@/composables/useDirPicker'
import {
  addAsset,
  addWorkItem,
  describeProjectError,
  linkTask,
  removeAsset,
  removeWorkItem,
  updateProjectConfig,
  updateWorkItem,
  workItemStatusLabel,
  workItemStatusOptions,
  type CapabilityRef,
  type InputRef,
  type ProjectSnapshot,
  type WorkItemPatch,
} from '@/composables/useProject'

const route = useRoute()
const WORK_ITEM_STATUS = computed(() => workItemStatusOptions())
const router = useRouter()
const projectId = computed(() => String(route.params.id ?? ''))

type Tab = 'config' | 'work-items' | 'assets' | 'activity' | 'files' | 'term' | 'browser'
const tab = ref<Tab>('config')

const snapshot = ref<ProjectSnapshot | null>(null)
const loading = ref(false)
const errorText = ref('')
const okText = ref('')

const TABS = computed<Array<{ key: Tab; label: string }>>(() => [
  { key: 'config', label: t('项目配置') },
  { key: 'work-items', label: t('计划项') },
  { key: 'assets', label: t('关联资产') },
  { key: 'activity', label: t('活动') },
  // 文件 / 终端 / 浏览器原本常驻在对话页两侧，把对话压成窄缝；
  // 它们是「进项目」之后才用的工具，归到这里最合身。
  { key: 'files', label: t('文件') },
  { key: 'term', label: t('终端') },
  { key: 'browser', label: t('浏览器') },
])

/** 工具面：占满剩余高度，不用文档流的卡片内边距。 */
const toolTab = computed(() => tab.value === 'files' || tab.value === 'term' || tab.value === 'browser')
/** 工具面需要工作目录；没目录时说清楚缺什么，而不是渲染一个空壳。 */
const needPath = computed(() => (tab.value === 'files' || tab.value === 'term') && !snapshot.value?.project.path)

const app = computed(() => snapshot.value?.project)
const usage = computed(() => snapshot.value?.instruction_usage)
const workItems = computed(() => snapshot.value?.work_items ?? [])
const assets = computed(() => snapshot.value?.assets ?? [])
const activity = computed(() => snapshot.value?.activity ?? [])

/** 预算条：用量 / 预算，超 80% 转警告色，避免用户写超了才发现。 */
const usagePercent = computed(() => {
  const u = usage.value
  if (!u || !u.budget) return 0
  return Math.min(100, Math.round((u.tokens / u.budget) * 100))
})
const usageLevel = computed(() => (usagePercent.value >= 100 ? 'over' : usagePercent.value >= 80 ? 'warn' : 'ok'))

// ── 配置修订 ──────────────────────────────────────────────────
const configDraft = ref('')
const capabilityText = ref('')
const revisionInfo = ref('')
const savingConfig = ref(false)

const capabilities = computed<CapabilityRef[]>(() => {
  const raw = capabilityText.value.trim()
  if (!raw) return []
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [head, ...rest] = line.split(/\s+/)
      const [kind, id] = head.split(':')
      return { kind: kind || 'skill', id: id || head, label: rest.join(' ') || id || head } as CapabilityRef
    })
})

/** 可用能力候选：当前配置的 kind:id 组合，供粘贴时做提示。 */
const boundCaps = computed(() => snapshot.value?.config?.capabilities ?? [])

// ── 目录绑定 ──────────────────────────────────────────────────
const pickingDir = ref(false)

async function bindDirectory() {
  pickingDir.value = true
  // AUDIT-016①：同 ProjectsView——系统选择器不返回时超时复位并明示，
  // 不把界面永久停在 picking 态。
  const { dir, timedOut } = await pickDirectoryGuarded(app.value?.path)
  pickingDir.value = false
  if (timedOut) {
    errorText.value = PICK_TIMEOUT_NOTE()
    return
  }
  if (!dir) return
  const next = await invoke<ProjectSnapshot>('project_set_path', {
    id: projectId.value,
    path: dir,
  }).catch((e) => {
    errorText.value = describeProjectError(e, t('绑定失败'))
    return null
  })
  if (next) {
    snapshot.value = next
    okText.value = t('已绑定目录 {0}', [dir])
  }
}

// ── 计划项 ────────────────────────────────────────────────────
const newWorkItem = ref('')
const addingWork = ref(false)

async function addItem() {
  const title = newWorkItem.value.trim()
  if (!title || addingWork.value) return
  addingWork.value = true
  const next = await addWorkItem(projectId.value, title).catch((e) => {
    errorText.value = describeProjectError(e, t('新增失败'))
    return null
  })
  addingWork.value = false
  if (next) {
    snapshot.value = next
    newWorkItem.value = ''
    okText.value = t('已新增计划项')
  }
}

function patchOf(item: { id: string; title: string; status: string; assignee?: string; priority: string; tags: string[] }): WorkItemPatch {
  return {
    id: item.id,
    title: item.title,
    status: item.status,
    assignee: item.assignee ?? '',
    priority: item.priority,
    tags: item.tags,
  }
}

async function setStatus(item: (typeof workItems.value)[number], status: string) {
  const next = await updateWorkItem(projectId.value, { id: item.id, status }, item.revision).catch((e) => {
    errorText.value = describeProjectError(e, t('更新失败'))
    return null
  })
  if (next) {
    snapshot.value = next
    okText.value = t('状态已更新')
  }
}

async function dropItem(item: { id: string }) {
  const next = await removeWorkItem(projectId.value, item.id).catch((e) => {
    errorText.value = describeProjectError(e, t('删除失败'))
    return null
  })
  if (next) {
    snapshot.value = next
    okText.value = t('已删除计划项')
  }
}

// ── 资产 ──────────────────────────────────────────────────────
const assetDraft = { nodeId: '', assetId: '', revisionId: '', name: '', kind: '' }
const newAsset = ref({ ...assetDraft })
const addingAsset = ref(false)

async function addOneAsset() {
  const form = newAsset.value
  if (!form.assetId.trim() || !form.name.trim() || addingAsset.value) return
  addingAsset.value = true
  const next = await addAsset(projectId.value, {
    node_id: form.nodeId.trim(),
    asset_id: form.assetId.trim(),
    revision_id: form.revisionId.trim() || 'default',
    name: form.name.trim(),
    kind: form.kind.trim() || 'file',
  }).catch((e) => {
    errorText.value = describeProjectError(e, t('关联失败'))
    return null
  })
  addingAsset.value = false
  if (next) {
    snapshot.value = next
    newAsset.value = { ...assetDraft }
    okText.value = t('已关联资产')
  }
}

async function unlinkAsset(item: { id: string }) {
  const next = await removeAsset(projectId.value, item.id).catch((e) => {
    errorText.value = describeProjectError(e, t('解除失败'))
    return null
  })
  if (next) {
    snapshot.value = next
    okText.value = t('已解除关联')
  }
}

// ── 会话任务绑定 ──────────────────────────────────────────────
const sessionId = ref('')
const taskTitle = ref('')
const taskWorkItem = ref('')
const taskCaps = ref('')
const linking = ref(false)

const linkedSessions = computed(() => snapshot.value?.tasks ?? [])

/** 计划项下拉：绑定会话任务时可挂到某条计划项上。 */
const workItemOptions = computed<SelectOption[]>(() => [
  { value: '', label: t('不绑定计划项') },
  ...workItems.value.map((w) => ({ value: w.id, label: w.title })),
])

/** 可引用对象：计划项与已关联资产。两者都带 revision，后端据此校验引用是否过期。 */
interface RefOption extends SelectOption {
  key: string
  kind: 'work-item' | 'asset'
  refId: string
  revision: string
}
const refOptions = computed<RefOption[]>(() => [
  ...workItems.value.map((w) => ({
    key: `work-item:${w.id}`,
    value: `work-item:${w.id}`,
    label: t('计划项 · {0}', [w.title]),
    kind: 'work-item' as const,
    refId: w.id,
    revision: w.revision,
  })),
  ...assets.value.map((a) => ({
    key: `asset:${a.id}`,
    value: `asset:${a.id}`,
    label: t('资产 · {0}', [a.name]),
    kind: 'asset' as const,
    refId: a.id,
    revision: a.revision_id,
  })),
])
const pickedRefKey = ref('')
const pickedRefs = ref<RefOption[]>([])

function addRef() {
  const hit = refOptions.value.find((o) => o.key === pickedRefKey.value)
  if (!hit) return
  if (!pickedRefs.value.some((r) => r.key === hit.key)) pickedRefs.value.push(hit)
  pickedRefKey.value = ''
}

function dropRef(key: string) {
  pickedRefs.value = pickedRefs.value.filter((r) => r.key !== key)
}

async function bindSession() {
  const sid = sessionId.value.trim()
  const title = taskTitle.value.trim()
  if (!sid || !title || linking.value) return
  const workItemId = taskWorkItem.value || undefined
  // 引用必须带 revision；不带会被内核判为过期。
  const references: InputRef[] = pickedRefs.value.map((r) => ({
    kind: r.kind,
    id: r.refId,
    revision: r.revision,
    label: r.label,
  }))
  // 能力必须来自项目当前配置（kind+id+revision 全等），所以从已绑定能力里回填 revision。
  const capabilities = taskCaps.value
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(/\s+/)[0])
    .map((spec) => {
      const [kind, id] = spec.split(':')
      const k = kind || 'skill'
      const i = id || spec
      const hit = boundCaps.value.find((c) => c.kind === k && c.id === i)
      return { kind: k, id: i, label: hit?.label || i, revision: hit?.revision } as CapabilityRef
    })
  linking.value = true
  const next = await linkTask(projectId.value, sid, title, workItemId, references, capabilities).catch((e) => {
    errorText.value = describeProjectError(e, t('绑定失败'))
    return null
  })
  linking.value = false
  if (next) {
    snapshot.value = next
    taskTitle.value = ''
    taskWorkItem.value = ''
    taskCaps.value = ''
    pickedRefKey.value = ''
    pickedRefs.value = []
    okText.value = t('会话已绑定到项目任务')
  }
}

async function saveConfig() {
  const config = snapshot.value?.config
  if (!config || savingConfig.value) return
  savingConfig.value = true
  const next = await updateProjectConfig(
    projectId.value,
    configDraft.value,
    capabilities.value,
    config.id,
    config.number,
  ).catch((e) => {
    errorText.value = describeProjectError(e, t('保存失败'))
    return null
  })
  savingConfig.value = false
  if (next) {
    snapshot.value = next
    revisionInfo.value = t('修订 #{0}', [next.config?.number ?? ''])
    okText.value = t('配置已保存为新的修订')
  }
}

function stamp(ts?: number) {
  if (!ts) return ''
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

async function refresh() {
  loading.value = true
  errorText.value = ''
  try {
    snapshot.value = await invoke<ProjectSnapshot | null>('project_get', { id: projectId.value })
  } catch (e) {
    snapshot.value = null
    errorText.value = describeProjectError(e, t('读取项目失败：{0}', [String(e)]))
    loading.value = false
    return
  }
  const config = snapshot.value?.config
  configDraft.value = config?.instruction ?? ''
  capabilityText.value = (config?.capabilities ?? [])
    .map((c) => `${c.kind}:${c.id}${c.label ? ` ${c.label}` : ''}`)
    .join('\n')
  revisionInfo.value = config ? t('修订 #{0}', [config.number]) : ''
  loading.value = false
}

async function goChat() {
  // 直接深链进工作台时活动项目未必是这一个，先落一次再跳，避免对话页读到旧项目。
  await invoke('project_set_active', { id: projectId.value }).catch(() => {})
  router.push('/chat')
}

onMounted(refresh)
</script>

<template>
  <section v-if="!app" class="pw pw-fallback">
    <p v-if="loading" class="pw-loading">{{ t('正在读取项目…') }}</p>
    <template v-else>
      <p class="pw-error">{{ errorText || t('项目不存在，或已被归档/删除。') }}</p>
      <AppButton variant="secondary" class="pw-back-btn" @click="router.push('/projects')">{{ t('返回项目列表') }}</AppButton>
    </template>
  </section>

  <section v-else class="pw" :class="{ tool: toolTab }">
    <header class="pw-head">
      <AppButton variant="icon" class="pw-back" :title="t('返回项目列表')" :aria-label="t('返回项目列表')" @click="router.push('/projects')">
        <AppIcon name="arrow-left" :size="15" />
      </AppButton>
      <span class="pw-icon"><AppIcon name="folder" :size="20" /></span>
      <div class="pw-title">
        <strong :title="app.name">{{ app.name }}</strong>
        <!-- 没有描述就不占一行：空项目不再显示「暂无描述」这句填充文案。 -->
        <small v-if="app.description" :title="app.description">{{ app.description }}</small>
      </div>
      <!-- 模式切换器常驻头部：进入工作台不消失，与对话页共用同一份档位。 -->
      <ModeSwitcher :model-value="thinkingLevel" width="auto" @update:model-value="setThinkingMode" />
      <AppButton variant="primary" class="pw-open-chat" @click="goChat">
        <AppIcon name="chat" :size="14" />
        <span>{{ t('在对话中打开') }}</span>
      </AppButton>
    </header>

    <div class="pw-meta">
      <span class="pw-chip">{{ t('修订 {0}', [revisionInfo.replace(t('修订 #'), '#')]) }}</span>
      <span v-if="app.path" class="pw-chip pw-chip-path" :title="app.path">{{ app.path }}</span>
      <span v-else class="pw-chip pw-chip-muted">{{ t('未绑定目录') }}<AppButton variant="text" class="pw-chip-btn" :disabled="pickingDir" @click="bindDirectory">
          {{ pickingDir ? t('选择中…') : t('选择目录') }}
        </AppButton>
      </span>
      <span v-if="stamp(app.updated_at)" class="pw-chip pw-chip-muted">{{ t('更新于 {0}', [stamp(app.updated_at)]) }}</span>
    </div>

    <p v-if="errorText" class="pw-error">{{ errorText }}</p>
    <p v-if="okText" class="pw-ok">{{ okText }}</p>

    <nav class="pw-tabs" role="tablist" :aria-label="t('项目视图')" @keydown="onTablistKeydown">
      <AppButton
        v-for="t in TABS"
        :key="t.key"
        variant="tab"
        role="tab"
        :aria-selected="tab === t.key"
        :tabindex="tab === t.key ? 0 : -1"
        class="pw-tab"
        :class="{ on: tab === t.key }"
        @click="tab = t.key"
      >
        {{ t.label }}
        <i v-if="t.key === 'work-items' && workItems.length">{{ workItems.length }}</i>
        <i v-if="t.key === 'assets' && assets.length">{{ assets.length }}</i>
      </AppButton>
    </nav>

    <div class="pw-body">
      <!-- 项目配置 -->
      <div v-if="tab === 'config'" class="pw-pane">
        <div class="pw-budget" :class="usageLevel">
          <div class="pw-budget-head">
            <b>{{ t('指令预算') }}</b>
            <span>{{ usage?.tokens ?? 0 }} / {{ usage?.budget ?? 0 }} tokens</span>
          </div>
          <div class="pw-bar"><i :style="{ '--budget-w': usagePercent + '%' }" /></div>
          <small v-if="usageLevel === 'over'" class="pw-warn-text">{{ t('已超出预算，保存会被内核拒绝，请先精简指令。') }}</small>
        </div>

        <div class="pw-pane-block">
          <b class="pw-label">{{ t('指令') }}</b>
          <AppTextarea v-model="configDraft" :rows="6" :placeholder="t('项目背景、协作规范与输出约束')" />
        </div>

        <div class="pw-pane-block">
          <b class="pw-label">{{ t('绑定能力') }}</b>
          <AppTextarea
            v-model="capabilityText"
            :rows="3"
            mono
            :placeholder="t('skill:pdf-tools 解析 PDF expert:reviewer 代码评审')"
          />
          <small class="pw-hint">{{ t('每行一条，格式') }}<code>{{ t('kind:id 名称') }}</code>{{ t('；可用 kind：skill / expert / connector。 当前已绑定 {0} 项。', [boundCaps.length]) }}</small>
        </div>

        <div class="pw-pane-actions">
          <span class="pw-muted">{{ t('每次保存生成一条新修订，旧修订保留可回溯。') }}</span>
          <AppButton variant="primary" class="pw-primary" :disabled="savingConfig || !configDraft.trim()" @click="saveConfig">
            {{ savingConfig ? t('保存中…') : t('保存为新修订') }}
          </AppButton>
        </div>
      </div>

      <!-- 计划项 -->
      <div v-else-if="tab === 'work-items'" class="pw-pane">
        <div class="pw-addrow">
          <AppInput v-model="newWorkItem" :placeholder="t('新增一个计划项，比如「完成登录页设计」')" />
          <AppButton variant="primary" class="pw-primary" :disabled="!newWorkItem.trim() || addingWork" @click="addItem">
            {{ addingWork ? t('添加中…') : t('添加') }}
          </AppButton>
        </div>

        <ul v-if="workItems.length" class="pw-list">
          <li v-for="item in workItems" :key="item.id" class="pw-row">
            <span class="pw-row-main">
              <strong :title="item.title">{{ item.title }}</strong>
              <small :title="item.priority + ' · ' + (item.tags.length ? item.tags.join('、') : t('无标签'))">{{ item.priority }} · {{ item.tags.length ? item.tags.join('、') : t('无标签') }}</small>
            </span>
            <AppSelect
              :model-value="item.status"
              :options="WORK_ITEM_STATUS"
              width="112px"
              @update:model-value="setStatus(item, $event)"
            />
            <AppButton variant="icon" class="pw-row-del" :title="t('删除')" :aria-label="t('删除计划项')" @click="dropItem(item)">
              <AppIcon name="close" :size="14" />
            </AppButton>
          </li>
        </ul>
        <p v-else class="pw-empty">{{ t('还没有计划项，先添加一条。') }}</p>
      </div>

      <!-- 关联资产 -->
      <div v-else-if="tab === 'assets'" class="pw-pane">
        <div class="pw-addrow pw-asset-form">
          <AppInput v-model="newAsset.nodeId" :placeholder="t('节点 id（资料库节点）')" />
          <AppInput v-model="newAsset.assetId" :placeholder="t('资产 id')" />
          <AppInput v-model="newAsset.name" :placeholder="t('资产名称')" />
          <AppInput v-model="newAsset.kind" :placeholder="t('类型')" />
          <AppInput v-model="newAsset.revisionId" :placeholder="t('版本')" />
          <AppButton
            variant="primary"
            class="pw-primary"
            :disabled="!newAsset.assetId.trim() || !newAsset.name.trim() || addingAsset"
            @click="addOneAsset"
          >{{ t('关联') }}</AppButton>
        </div>

        <ul v-if="assets.length" class="pw-list">
          <li v-for="a in assets" :key="a.id" class="pw-row">
            <span class="pw-row-main">
              <strong :title="a.name">{{ a.name }}</strong>
              <small :title="a.kind + ' · ' + a.asset_id + '@' + a.revision_id">{{ a.kind }} · {{ a.asset_id }}@{{ a.revision_id }}</small>
            </span>
            <AppButton variant="icon" class="pw-row-del" :title="t('解除关联')" :aria-label="t('解除关联')" @click="unlinkAsset(a)">
              <AppIcon name="close" :size="14" />
            </AppButton>
          </li>
        </ul>
        <p v-else class="pw-empty">{{ t('还没有关联资产。') }}</p>
      </div>

      <!-- 活动 -->
      <div v-else-if="tab === 'activity'" class="pw-pane">
        <ul v-if="activity.length" class="pw-activity">
          <li v-for="a in activity" :key="a.id">
            <span class="pw-activity-kind">{{ a.kind }}</span>
            <span class="pw-activity-text" :title="a.text">{{ a.text }}</span>
            <span class="pw-activity-time">{{ stamp(a.created_at) }}</span>
          </li>
        </ul>
        <p v-else class="pw-empty">{{ t('暂无活动记录。') }}</p>

        <div class="pw-pane-block">
          <b class="pw-label">{{ t('把会话绑定到项目任务') }}</b>
          <div class="pw-addrow">
            <AppInput v-model="sessionId" :placeholder="t('会话 id')" />
            <AppInput v-model="taskTitle" :placeholder="t('任务标题')" />
            <AppSelect v-model="taskWorkItem" :options="workItemOptions" :placeholder="t('绑定计划项')" />
          </div>

          <div class="pw-refs">
            <div class="pw-addrow">
              <AppSelect v-model="pickedRefKey" :options="refOptions" :placeholder="t('选择要引用的计划项 / 资产')" />
              <AppButton variant="text" class="pw-ghost" :disabled="!pickedRefKey" @click="addRef">{{ t('添加引用') }}</AppButton>
            </div>
            <ul v-if="pickedRefs.length" class="pw-ref-chips">
              <li v-for="r in pickedRefs" :key="r.key">
                <span>{{ r.label }}</span>
                <AppButton variant="icon" class="pw-row-del" :title="t('移除引用')" :aria-label="t('移除引用')" @click="dropRef(r.key)">
                  <AppIcon name="close" :size="12" />
                </AppButton>
              </li>
            </ul>
            <small class="pw-hint">{{ t('引用会带上当前修订号，内核校验过期即拒绝——避免会话拿着已改动的计划项继续推进。') }}</small>
          </div>
          <AppTextarea
            v-model="taskCaps"
            :rows="3"
            mono
            :placeholder="t('本次会话只借用这些能力（每行一条 kind:id）')"
          />
          <div class="pw-pane-actions">
            <AppButton variant="primary" class="pw-primary" :disabled="linking || !sessionId.trim() || !taskTitle.trim()" @click="bindSession">
              {{ linking ? t('绑定中…') : t('绑定会话') }}
            </AppButton>
          </div>
        </div>

        <ul v-if="linkedSessions.length" class="pw-list">
          <li v-for="item in linkedSessions" :key="item.id" class="pw-row">
            <span class="pw-row-main">
              <strong>{{ item.title }}</strong>
              <small>{{ t('{0} · 引用 {1} 项', [item.session_id, item.references.length]) }}</small>
            </span>
          </li>
        </ul>
      </div>

      <!-- 文件 / 终端 / 浏览器：占用剩余高度，不套卡片的文档流内边距 -->
      <FilesWorkspace v-else-if="tab === 'files' && app.path" :root="app.path" />
      <TerminalPanel v-else-if="tab === 'term' && app.path" :cwd="app.path" :root="app.path" />
      <AgentBrowserPane v-else-if="tab === 'browser'" />
      <div v-else-if="needPath" class="pw-pane">
        <p class="pw-empty">{{ t('这个项目还没有工作目录 —— 先在上面点「选择目录」，再回来开工具。') }}</p>
      </div>
    </div>
  </section>
</template>

<style src="./ProjectWorkspace.css" scoped></style>
