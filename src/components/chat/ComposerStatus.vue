<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import { activityMessage, type ActivityState } from '@/composables/useActivity'
import { fmtCost, fmtTokens } from '@/composables/piEvents'
import {
  codebaseIndexing,
  codebaseStatus,
  indexProjectCodebase,
} from '@/composables/useProject'

const props = defineProps<{
  state: ActivityState
  running: boolean
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: { total: number } } | null
  /** 当前活动项目 id：代码库索引的触发入口。 */
  projectId?: string | null
}>()
const emit = defineEmits<{ interrupt: [] }>()

const message = computed(() => activityMessage(props.state))
const phaseClass = computed(() => `phase-${props.state.phase}`)

/** 代码库状态一行只在「项目已经加载过索引状态」时出现，避免没项目时占位。 */
const codebaseVisible = computed(() => codebaseStatus.value !== null)
const codebaseClass = computed(() => {
  const s = codebaseStatus.value?.status
  if (codebaseIndexing.value) return 'indexing'
  if (s === 'error') return 'error'
  if (s === 'indexed') return 'ready'
  return 'idle'
})

const shortError = computed(() => {
  const e = codebaseStatus.value?.error
  if (!e) return ''
  return e.length > 60 ? `${e.slice(0, 57)}…` : e
})

/** 手动（重新）索引：仅在绑定了活动项目时可用。 */
async function reindex() {
  if (!props.projectId) return
  await indexProjectCodebase(props.projectId).catch(() => {})
}
</script>

<template>
  <div class="composer-status" :class="[phaseClass, { running }]">
    <template v-if="running">
      <span class="spinner" aria-hidden="true" />
      <span class="status-main">{{ message }}</span>
      <button
        type="button"
        class="abort"
        title="中断本轮（pi_stop）"
        @click="emit('interrupt')"
      >
        <AppIcon name="stop" :size="11" />
        <span>中断</span>
      </button>
    </template>

    <template v-else>
      <span class="hint">
        <AppIcon name="corner-down-left" :size="11" /> Enter 发送 · Shift+Enter 换行
      </span>
      <span v-if="usage" class="usage-chip" title="本会话累计 token 用量（内核真实上报）">
        <AppIcon name="zap" :size="11" />
        ↑{{ fmtTokens(usage.input + usage.cacheRead + usage.cacheWrite) }}
        ↓{{ fmtTokens(usage.output) }}
        Σ{{ fmtTokens(usage.totalTokens) }}
        · {{ fmtCost(usage.cost.total) }}
      </span>
    </template>

    <!--
      代码库索引状态：独立于「对话是否在生成」，始终可见。
      用户之前的痛点正是「不知道有没有在跑、查没查」——这一行专门回答它。
    -->
    <span v-if="codebaseVisible" class="codebase" :class="codebaseClass">
      <template v-if="codebaseIndexing">
        <span class="spinner sm" aria-hidden="true" />
        <span>索引代码库中…</span>
      </template>
      <template v-else-if="codebaseStatus?.status === 'indexed'">
        <AppIcon name="database" :size="11" />
        <span>已索引 {{ codebaseStatus.nodes }} 节点 / {{ codebaseStatus.edges }} 边</span>
        <button type="button" class="relink" title="重新索引当前项目" @click="reindex">
          <AppIcon name="refresh" :size="11" />
          <span>重建</span>
        </button>
      </template>
      <template v-else-if="codebaseStatus?.status === 'error'">
        <AppIcon name="database" :size="11" />
        <span>索引失败：{{ shortError }}</span>
        <button type="button" class="relink" title="重试索引" @click="reindex">
          <AppIcon name="refresh" :size="11" />
          <span>重试</span>
        </button>
      </template>
      <template v-else>
        <AppIcon name="database" :size="11" />
        <span>代码库未索引</span>
        <button type="button" class="relink" title="索引当前项目" @click="reindex">
          <AppIcon name="refresh" :size="11" />
          <span>索引</span>
        </button>
      </template>
    </span>
  </div>
</template>

<style src="./ComposerStatus.css" scoped></style>
