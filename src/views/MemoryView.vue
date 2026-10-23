<script setup lang="ts">
/**
 * 记忆层（长期记忆 + 知识库检索入口）。
 * 读取 `agent_memory_list`；写入走 `agent_memory_store`（脱离 Pi 也能记，
 * 记下的条目会被 Pi 工具 `memory_store`/`memory_recall` 读取）。
 */
import { onMounted, ref } from 'vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppTextarea from '@/components/ui/AppTextarea.vue'
import AppInput from '@/components/ui/AppInput.vue'
import RuntimeNote from '@/components/runtime/RuntimeNote.vue'
import {
  agentMemoryList,
  agentMemoryStore,
  memoryVecStatus,
  memoryVecSearch,
  memoryVecReindex,
  type MemoryEntry,
  type MemoryVecHit,
  type MemoryVecStatus,
} from '@/composables/useAgentOps'

defineProps<{ embedded?: boolean }>()

const items = ref<MemoryEntry[]>([])
const busy = ref(false)
const status = ref('')
const dialog = ref(false)
const formText = ref('')
const formTags = ref('')

// —— 语义向量检索（B5，Rust/LanceDB 侧；与词面记忆列表互补）——
const vecStatus = ref<MemoryVecStatus | null>(null)
const vecResults = ref<MemoryVecHit[]>([])
const vecQuery = ref('')
const vecBusy = ref(false)
const vecMsg = ref('')

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
    vecMsg.value = '请输入检索词'
    return
  }
  vecBusy.value = true
  vecMsg.value = ''
  vecResults.value = []
  try {
    vecResults.value = await memoryVecSearch(q, 8)
    if (!vecResults.value.length) vecMsg.value = '向量库暂无命中（先写入记忆或重建索引）'
  } catch (e) {
    vecMsg.value = String(e)
  }
  vecBusy.value = false
}

async function reindexVec() {
  vecBusy.value = true
  vecMsg.value = ''
  try {
    const r = await memoryVecReindex()
    vecMsg.value = `重建完成：索引 ${r.indexed} 条，跳过 ${r.skipped} 条${
      r.errors.length ? `，错误 ${r.errors.length}` : ''
    }`
    await loadVecStatus()
  } catch (e) {
    vecMsg.value = String(e)
  }
  vecBusy.value = false
}

function rel(ts?: number) {
  if (!ts) return ''
  const d = Date.now() - ts
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`
  return new Date(ts).toLocaleString()
}

async function refresh() {
  busy.value = true
  status.value = ''
  try {
    items.value = await agentMemoryList()
  } catch (e) {
    status.value = String(e)
  }
  busy.value = false
}

async function submit() {
  const text = formText.value.trim()
  const tags = formTags.value
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (!text) {
    status.value = '请填写记忆内容'
    return
  }
  try {
    await agentMemoryStore(text, tags)
    status.value = '已写入记忆'
    dialog.value = false
    formText.value = ''
    formTags.value = ''
    await refresh()
  } catch (e) {
    status.value = String(e)
  }
}

onMounted(() => {
  refresh()
  loadVecStatus()
})
</script>

<template>
  <section class="agent-ops memory" :class="{ embedded }">
    <RuntimeNote />

    <header class="aops-head">
      <div class="aops-title">
        <h1>记忆层</h1>
        <p class="muted">跨会话长期记忆与知识库检索入口。写入的条目可被对话里的 <code>memory_recall</code> 召回，支撑 RAG 式知识复用。</p>
      </div>
      <div class="aops-meta">
        <span class="badge">{{ items.length }} 条</span>
        <button class="tool-btn" :disabled="busy" title="刷新" @click="refresh()">
          <AppIcon name="refresh" :size="14" />
        </button>
      </div>
    </header>

    <div class="aops-toolbar">
      <button class="btn primary" @click="dialog = true">
        <AppIcon name="plus" :size="14" /> 写入记忆
      </button>
      <span v-if="status" class="aops-status" :class="{ err: status.startsWith('请') }">{{ status }}</span>
    </div>

    <section class="vec-panel">
      <header class="vec-head">
        <AppIcon name="sparkles" :size="15" />
        <span>语义向量检索</span>
        <span class="muted vec-sub">同义改写也能召回（bge-m3 · LanceDB）</span>
      </header>

      <div class="vec-bar">
        <AppIcon name="search" :size="14" />
        <!-- AUDIT-005：原生 input → UI Kit AppInput（v-model + enter 行为不变） -->
        <AppInput
          v-model="vecQuery"
          class="vec-input"
          placeholder="例如：连不上数据库怎么排查"
          @keyup.enter="runVecSearch()"
        />
        <button class="btn" :disabled="vecBusy" @click="runVecSearch()">检索</button>
        <button
          class="tool-btn"
          :disabled="vecBusy"
          title="按当前记忆全量重建向量索引"
          @click="reindexVec()"
        >
          <AppIcon name="refresh" :size="14" />
        </button>
      </div>

      <div v-if="vecStatus" class="vec-meta">
        <span class="badge">{{ vecStatus.rows }} 条向量</span>
        <span class="muted">{{ vecStatus.embedding.model || '未配置' }} @ {{ vecStatus.embedding.baseUrl || '—' }}</span>
        <span v-if="!vecStatus.exists" class="vec-warn">索引未建：写入记忆或点重建</span>
      </div>

      <ul v-if="vecResults.length" class="vec-list">
        <li v-for="h in vecResults" :key="h.id" class="vec-card">
          <span class="vec-score">{{ (h.score * 100).toFixed(0) }}%</span>
          <span class="vec-text">{{ h.text }}</span>
          <span v-if="h.tags" class="vec-tags">{{ h.tags }}</span>
        </li>
      </ul>
      <p v-if="vecMsg" class="aops-status" :class="{ err: vecMsg.startsWith('请') || vecMsg.startsWith('需在') }">
        {{ vecMsg }}
      </p>
    </section>

    <ul v-if="items.length" class="mem-list">
      <li v-for="(m, i) in items" :key="i" class="mem-card">
        <div class="mem-top">
          <AppIcon name="database" :size="15" />
          <span class="mem-time">{{ rel(m.ts) }}</span>
        </div>
        <p class="mem-text">{{ m.text }}</p>
        <div v-if="m.tags?.length" class="mem-tags">
          <span v-for="t in m.tags" :key="t" class="chip">{{ t }}</span>
        </div>
      </li>
    </ul>

    <div v-else class="aops-empty">
      <AppIcon name="database" :size="36" />
      <strong>还没有记忆</strong>
      <span class="muted">点「写入记忆」记下一条经验，或在对话里用 <code>/memory</code> 查看。</span>
    </div>

    <AppModal :open="dialog" title="写入记忆" size="md" @close="dialog = false">
      <label class="aops-row">
        <span>内容</span>
        <AppTextarea v-model="formText" placeholder="例如：用户偏好电报体、序号列举的汇报风格" :rows="4" />
      </label>
      <label class="aops-row">
        <span>标签（逗号/空格）</span>
        <AppInput v-model="formTags" placeholder="偏好, 汇报风格" />
      </label>
      <template #footer>
        <button class="aops-plain" @click="dialog = false">取消</button>
        <button class="btn primary" @click="submit()">保存</button>
      </template>
    </AppModal>
  </section>
</template>

<style src="./MemoryView.css" scoped></style>
