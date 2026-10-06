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
  type MemoryEntry,
} from '@/composables/useAgentOps'

defineProps<{ embedded?: boolean }>()

const items = ref<MemoryEntry[]>([])
const busy = ref(false)
const status = ref('')
const dialog = ref(false)
const formText = ref('')
const formTags = ref('')

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

onMounted(refresh)
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
