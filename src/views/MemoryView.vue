<script setup lang="ts">
import { t } from '@/i18n'
/**
 * 记忆层（长期记忆 + 知识库检索入口）。
 * 读取 `agent_memory_list`；写入走 `agent_memory_store`（脱离 Pi 也能记，
 * 记下的条目会被 Pi 工具 `memory_store`/`memory_recall` 读取）。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppTextarea from '@/components/ui/AppTextarea.vue'
import AppInput from '@/components/ui/AppInput.vue'
import RuntimeNote from '@/components/runtime/RuntimeNote.vue'
import {
  agentMemoryForget,
  agentMemoryList,
  agentMemoryPurge,
  agentMemoryRestore,
  agentMemoryStore,
  agentMemoryTrash,
  agentMemoryUpdate,
  agentProfileGet,
  memoryVecStatus,
  memoryVecSearch,
  memoryVecReindex,
  type MemoryEntry,
  type MemoryProfile,
  type MemoryTrashEntry,
  type MemoryVecHit,
  type MemoryVecStatus,
} from '@/composables/useAgentOps'

defineProps<{ embedded?: boolean }>()

const items = ref<MemoryEntry[]>([])
const busy = ref(false)
const status = ref('')
const statusError = ref(false)
const dialog = ref(false)
const formText = ref('')
const formTags = ref('')

// —— 24 小时撤销窗口：删除只进待撤销态，到期由后端调度 tick 硬失效 ——
const trash = ref<MemoryTrashEntry[]>([])
const delTarget = ref<MemoryEntry | null>(null)
const delBusy = ref(false)
const purgeTarget = ref<MemoryEntry | null>(null)
const purgeBusy = ref(false)
let unlisten: UnlistenFn | null = null

// —— 检索与更正：本地 substring 过滤，不引第二套评分 ——
const query = ref('')
const visible = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return items.value
  return items.value.filter(
    (m) => m.text.toLowerCase().includes(q) || m.tags.some((t) => t.toLowerCase().includes(q)),
  )
})

const editTarget = ref<MemoryEntry | null>(null)
const editText = ref('')
const editTags = ref('')
const editBusy = ref(false)

// —— 画像：记忆保留标签折叠出的只读视图 ——
const profile = ref<MemoryProfile | null>(null)
const PROFILE_FIELDS = computed(() => [
  { key: 'preference', label: t('偏好'), tag: 'profile:preference' },
  { key: 'taboo', label: t('禁忌'), tag: 'profile:taboo' },
  { key: 'goal', label: t('长期目标'), tag: 'profile:goal' },
  { key: 'workflow', label: t('常用工作方式'), tag: 'profile:workflow' },
] as const)

function profileValue(key: string): string {
  const f = (profile.value as Record<string, { value?: string } | undefined> | null)?.[key]
  return f?.value ?? ''
}

// —— 语义向量检索（B5，Rust/LanceDB 侧；与词面记忆列表互补）——
const vecStatus = ref<MemoryVecStatus | null>(null)
const vecResults = ref<MemoryVecHit[]>([])
const vecQuery = ref('')
const vecBusy = ref(false)
const vecMsg = ref('')
const vecMsgError = ref(false)

async function loadVecStatus() {
  try {
    vecStatus.value = await memoryVecStatus()
  } catch {
    vecStatus.value = null
  }
}

async function runVecSearch() {
  const q = vecQuery.value.trim()
  if (!q) {
    vecMsg.value = t('请输入检索词')
    return
  }
  vecBusy.value = true
  vecMsg.value = ''
  vecMsgError.value = false
  vecResults.value = []
  try {
    vecResults.value = await memoryVecSearch(q, 8)
    if (!vecResults.value.length) vecMsg.value = t('向量库暂无命中（先写入记忆或重建索引）')
  } catch (e) {
    vecMsg.value = String(e)
    vecMsgError.value = true
  }
  vecBusy.value = false
}

async function reindexVec() {
  vecBusy.value = true
  vecMsg.value = ''
  vecMsgError.value = false
  try {
    const r = await memoryVecReindex()
    vecMsg.value = t('重建完成：索引 {0} 条，跳过 {1} 条{2}', [r.indexed, r.skipped, r.errors.length ? t('，错误 {0}', [r.errors.length]) : ''])
    await loadVecStatus()
  } catch (e) {
    vecMsg.value = String(e)
    vecMsgError.value = true
  }
  vecBusy.value = false
}

function rel(ts?: number) {
  if (!ts) return ''
  const d = Date.now() - ts
  if (d < 60_000) return t('刚刚')
  if (d < 3_600_000) return t('{0} 分钟前', [Math.floor(d / 60_000)])
  if (d < 86_400_000) return t('{0} 小时前', [Math.floor(d / 3_600_000)])
  return new Date(ts).toLocaleString()
}

async function refresh() {
  busy.value = true
  status.value = ''
  statusError.value = false
  try {
    items.value = await agentMemoryList()
    trash.value = await agentMemoryTrash()
    profile.value = await agentProfileGet()
  } catch (e) {
    status.value = String(e)
    statusError.value = true
  }
  busy.value = false
}

function openEdit(m: MemoryEntry) {
  editTarget.value = m
  editText.value = m.text
  editTags.value = m.tags.join(', ')
}

async function submitEdit() {
  const target = editTarget.value
  const text = editText.value.trim()
  if (!target || !text) {
    status.value = t('请填写记忆内容')
    return
  }
  editBusy.value = true
  try {
    const tags = editTags.value
      .split(/[,，\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    items.value = await agentMemoryUpdate(target.id, text, tags)
    profile.value = await agentProfileGet()
    editTarget.value = null
    status.value = t('已更正这条记忆')
  } catch (e) {
    status.value = String(e)
    statusError.value = true
  }
  editBusy.value = false
}

/** 画像没有独立表单：改 = 写一条带保留标签的新记忆。 */
function openProfileEdit(tag: string) {
  formText.value = ''
  formTags.value = `${tag}=`
  dialog.value = true
}

async function confirmPurge() {
  const target = purgeTarget.value
  if (!target) return
  purgeBusy.value = true
  try {
    items.value = await agentMemoryPurge(target.id)
    trash.value = await agentMemoryTrash()
    profile.value = await agentProfileGet()
    purgeTarget.value = null
    status.value = t('已永久删除，不会进入 24 小时窗口')
  } catch (e) {
    status.value = String(e)
    statusError.value = true
  }
  purgeBusy.value = false
}

/** 剩余可撤销时间：到期由后端 tick 追加 purge，之后不可恢复。 */
function remain(purgeAt?: number) {
  const ms = (purgeAt ?? 0) - Date.now()
  if (ms <= 0) return t('即将永久删除')
  const h = Math.floor(ms / 3_600_000)
  if (h >= 1) return t('还剩 {0} 小时', [h])
  return t('还剩 {0} 分钟', [Math.max(1, Math.floor(ms / 60_000))])
}

async function confirmDelete() {
  const target = delTarget.value
  if (!target) return
  delBusy.value = true
  try {
    items.value = await agentMemoryForget(target.id)
    delTarget.value = null
    trash.value = await agentMemoryTrash()
    profile.value = await agentProfileGet()
    status.value = t('已删除，24 小时内可在下方恢复')
  } catch (e) {
    status.value = String(e)
    statusError.value = true
  }
  delBusy.value = false
}

async function undoDelete(id: string) {
  try {
    items.value = await agentMemoryRestore(id)
    trash.value = await agentMemoryTrash()
    profile.value = await agentProfileGet()
    status.value = t('已恢复这条记忆')
  } catch (e) {
    status.value = String(e)
    statusError.value = true
  }
}

async function submit() {
  const text = formText.value.trim()
  const tags = formTags.value
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (!text) {
    status.value = t('请填写记忆内容')
    return
  }
  try {
    await agentMemoryStore(text, tags)
    status.value = t('已写入记忆')
    dialog.value = false
    formText.value = ''
    formTags.value = ''
    await refresh()
  } catch (e) {
    status.value = String(e)
    statusError.value = true
  }
}

onMounted(() => {
  refresh()
  loadVecStatus()
  // 到期硬失效由后端 tick 完成，前端只跟一次刷新。
  listen<number>('memory://changed', () => refresh())
    .then((fn) => {
      unlisten = fn
    })
    .catch(() => {
      unlisten = null
    })
})

onUnmounted(() => {
  unlisten?.()
  unlisten = null
})
</script>

<template>
  <section class="agent-ops memory" :class="{ embedded }">
    <RuntimeNote />

    <header class="aops-head">
      <div class="aops-title">
        <h1>{{ t('记忆层') }}</h1>
        <p class="muted">{{ t('跨会话长期记忆与知识库检索入口。写入的条目可被对话里的') }}<code>memory_recall</code>{{ t('召回，支撑 RAG 式知识复用。') }}</p>
      </div>
      <div class="aops-meta">
        <span class="badge">{{ t('{0} 条', [items.length]) }}</span>
        <AppButton variant="icon" class="tool-btn" :disabled="busy" :title="t('刷新')" @click="refresh()">
          <AppIcon name="refresh" :size="14" />
        </AppButton>
      </div>
    </header>

    <div class="aops-toolbar">
      <AppButton variant="primary" class="btn primary" @click="dialog = true">
        <AppIcon name="plus" :size="14" />{{ t('写入记忆') }}</AppButton>
      <div class="mem-search">
        <AppIcon name="search" :size="14" />
        <AppInput v-model="query" :placeholder="t('按正文或标签过滤')" />
      </div>
      <span v-if="status" class="aops-status" :class="{ err: statusError }">{{ status }}</span>
    </div>

    <section v-if="profile && (profile.preference || profile.taboo || profile.goal || profile.workflow)" class="prof-panel">
      <header class="prof-head">
        <AppIcon name="sparkles" :size="15" />
        <span>{{ t('用户画像') }}</span>
        <span class="muted prof-sub">{{ t('由记忆保留标签折叠生成，无独立档案') }}</span>
      </header>
      <ul class="prof-list">
        <li v-for="f in PROFILE_FIELDS" :key="f.key" class="prof-row">
          <span class="prof-label">{{ f.label }}</span>
          <span class="prof-value" :class="{ faint: !profileValue(f.key) }">
            {{ profileValue(f.key) || t('暂无证据') }}
          </span>
          <AppButton variant="text" class="aops-plain prof-edit" :title="t('写入一条 {0} 记忆', [f.tag])" @click="openProfileEdit(f.tag)">{{ t('改') }}</AppButton>
        </li>
      </ul>
    </section>

    <section class="vec-panel">
      <header class="vec-head">
        <AppIcon name="sparkles" :size="15" />
        <span>{{ t('语义向量检索') }}</span>
        <span class="muted vec-sub">{{ t('同义改写也能召回（bge-m3 · LanceDB）') }}</span>
      </header>

      <div class="vec-bar">
        <AppIcon name="search" :size="14" />
        <!-- AUDIT-005：原生 input → UI Kit AppInput（v-model + enter 行为不变） -->
        <AppInput
          v-model="vecQuery"
          class="vec-input"
          :placeholder="t('例如：连不上数据库怎么排查')"
          @keyup.enter="runVecSearch()"
        />
        <AppButton variant="secondary" class="btn" :disabled="vecBusy" @click="runVecSearch()">{{ t('检索') }}</AppButton>
        <AppButton
          variant="icon"
          class="tool-btn"
          :disabled="vecBusy"
          :title="t('按当前记忆全量重建向量索引')"
          @click="reindexVec()"
        >
          <AppIcon name="refresh" :size="14" />
        </AppButton>
      </div>

      <div v-if="vecStatus" class="vec-meta">
        <span class="badge">{{ t('{0} 条向量', [vecStatus.rows]) }}</span>
        <span class="muted">{{ vecStatus.embedding.model || t('未配置') }} @ {{ vecStatus.embedding.baseUrl || '—' }}</span>
        <span v-if="!vecStatus.exists" class="vec-warn">{{ t('索引未建：写入记忆或点重建') }}</span>
      </div>

      <ul v-if="vecResults.length" class="vec-list">
        <li v-for="h in vecResults" :key="h.id" class="vec-card">
          <span class="vec-score">{{ (h.score * 100).toFixed(0) }}%</span>
          <span class="vec-text">{{ h.text }}</span>
          <span v-if="h.tags" class="vec-tags">{{ h.tags }}</span>
        </li>
      </ul>
      <p v-if="vecMsg" class="aops-status" :class="{ err: vecMsgError }">
        {{ vecMsg }}
      </p>
    </section>

    <section v-if="trash.length" class="trash-panel">
      <header class="trash-head">
        <AppIcon name="refresh" :size="15" />
        <span>{{ t('待撤销') }}</span>
        <span class="muted trash-sub">{{ t('删除后 24 小时内可恢复，到期自动永久删除') }}</span>
      </header>
      <ul class="trash-list">
        <li v-for="row in trash" :key="row.id" class="trash-card">
          <div class="trash-main">
            <p class="mem-text">{{ row.text }}</p>
            <span class="trash-tip">{{ remain(row.purgeAt) }}</span>
          </div>
          <AppButton variant="secondary" class="btn" @click="undoDelete(row.id)">
            <AppIcon name="refresh" :size="13" />{{ t('恢复') }}</AppButton>
          <AppButton variant="danger" class="btn danger" @click="purgeTarget = row">{{ t('永久删除') }}</AppButton>
        </li>
      </ul>
    </section>

    <!-- 骨架屏替代纯文字「加载中」，首屏不闪空白（ui-kit 统一原语） -->
    <ul v-if="busy && !visible.length" class="mem-list mem-skeleton" aria-busy="true">
      <li v-for="i in 3" :key="i" class="mem-card">
        <!-- 与真实卡片同构：1 行头部 + 正文 + 标签行，加载完成不跳高度。 -->
        <div class="skeleton sk-line w-40"></div>
        <div class="skeleton sk-line"></div>
        <div class="skeleton sk-line"></div>
        <div class="skeleton sk-line w-60"></div>
      </li>
    </ul>

    <ul v-else-if="visible.length" class="mem-list">
      <li v-for="m in visible" :key="m.id" class="mem-card">
        <div class="mem-top">
          <AppIcon name="database" :size="15" />
          <span class="mem-time">{{ rel(m.ts) }}</span>
          <AppButton variant="text" class="aops-plain mem-edit" @click="openEdit(m)">{{ t('更正') }}</AppButton>
          <AppButton
            variant="icon"
            class="tool-btn mem-del"
            :title="t('删除记忆（24 小时内可撤销）')"
            :aria-label="t('删除这条记忆')"
            @click="delTarget = m"
          >
            <AppIcon name="trash" :size="14" />
          </AppButton>
          <AppButton variant="text" class="aops-plain mem-purge" @click="purgeTarget = m">{{ t('永久删除') }}</AppButton>
        </div>
        <p class="mem-text" :title="m.text">{{ m.text }}</p>
        <div v-if="m.tags?.length" class="mem-tags">
          <span v-for="t in m.tags" :key="t" class="chip">{{ t }}</span>
        </div>
      </li>
    </ul>

    <div v-else class="aops-empty">
      <AppIcon name="database" :size="36" />
      <strong>{{ query.trim() ? t('没有匹配的记忆') : trash.length ? t('没有有效记忆') : t('还没有记忆') }}</strong>
      <span class="muted">
        {{ query.trim()
            ? t('换个关键词，或清空搜索框。')
            : trash.length
              ? t('下面的待撤销条目可在 24 小时内恢复。')
              : t('点「写入记忆」记下一条经验，或在对话里用 /memory 查看。') }}
      </span>
    </div>

    <AppModal :open="dialog" :title="t('写入记忆')" size="md" @close="dialog = false">
      <label class="aops-row">
        <span>{{ t('内容') }}</span>
        <AppTextarea v-model="formText" :placeholder="t('例如：用户偏好电报体、序号列举的汇报风格')" :rows="4" />
      </label>
      <label class="aops-row">
        <span>{{ t('标签（逗号/空格）') }}</span>
        <AppInput v-model="formTags" :placeholder="t('偏好, 汇报风格')" />
      </label>
      <template #footer>
        <AppButton variant="text" class="aops-plain" @click="dialog = false">{{ t('取消') }}</AppButton>
        <AppButton variant="primary" class="btn primary" @click="submit()">{{ t('保存') }}</AppButton>
      </template>
    </AppModal>

    <AppModal
      :open="!!delTarget"
      :title="t('删除这条记忆？')"
      size="sm"
      @close="delTarget = null"
    >
      <p class="del-note">{{ t('删除后立即不再被召回，并在 24 小时内保留恢复入口。到期后自动永久删除。') }}</p>
      <p class="del-preview">{{ delTarget?.text }}</p>
      <template #footer>
        <AppButton variant="text" class="aops-plain" @click="delTarget = null">{{ t('取消') }}</AppButton>
        <AppButton variant="text" class="aops-plain mem-now" @click="purgeTarget = delTarget; delTarget = null">{{ t('立即永久删除') }}</AppButton>
        <AppButton variant="primary" class="btn primary" :disabled="delBusy" @click="confirmDelete()">
          {{ delBusy ? t('删除中…') : t('删除') }}
        </AppButton>
      </template>
    </AppModal>

    <AppModal :open="!!editTarget" :title="t('更正这条记忆')" size="md" @close="editTarget = null">
      <label class="aops-row">
        <span>{{ t('内容') }}</span>
        <AppTextarea v-model="editText" :rows="4" />
      </label>
      <label class="aops-row">
        <span>{{ t('标签（逗号/空格）') }}</span>
        <AppInput v-model="editTags" />
      </label>
      <template #footer>
        <AppButton variant="text" class="aops-plain" @click="editTarget = null">{{ t('取消') }}</AppButton>
        <AppButton variant="primary" class="btn primary" :disabled="editBusy" @click="submitEdit()">
          {{ editBusy ? t('保存中…') : t('保存') }}
        </AppButton>
      </template>
    </AppModal>

    <AppModal :open="!!purgeTarget" :title="t('永久删除这条记忆？')" size="sm" @close="purgeTarget = null">
      <p class="del-note">{{ t('立即硬失效，不进入 24 小时窗口，不可恢复。会在') }}<code>memory-audit.jsonl</code>{{ t('留一条审计， 之后列表、召回与向量检索都不会再返回它。') }}</p>
      <p class="del-preview">{{ purgeTarget?.text }}</p>
      <template #footer>
        <AppButton variant="text" class="aops-plain" @click="purgeTarget = null">{{ t('取消') }}</AppButton>
        <AppButton variant="danger" class="btn danger" :disabled="purgeBusy" @click="confirmPurge()">
          {{ purgeBusy ? t('删除中…') : t('永久删除') }}
        </AppButton>
      </template>
    </AppModal>
  </section>
</template>

<style src="./MemoryView.css" scoped></style>
