<template>
  <div class="sess">
    <div class="bar">
      <button :disabled="loading" @click="refresh">
        <AppIcon name="refresh" :size="12" />
        <span>刷新</span>
      </button>
      <button :disabled="!forkable || loading" @click="forkEnd" title="重新打开最后一条用户消息，从这里续跑新分支">
        分叉末端
      </button>
      <span class="count">{{ nodes.length }} 条</span>
    </div>

    <div v-if="empty" class="empty">暂无会话条目。发起一次对话后，这里会长出分支树。</div>

    <ul v-else class="rows">
      <li
        v-for="row in shown"
        :key="row.id"
        class="row"
        :class="[{ leaf: row.isLeaf, user: row.role === 'user' }, row.kind]"
        :style="{ '--row-indent': `${8 + row.depth * 14}px` }"
        @click="select(row)"
      >
        <!-- 功能性动态值（树深度缩进），豁免纯样式抽离铁律：CSS 变量传值 -->
        <span class="icon"><AppIcon :name="iconOf(row.kind)" :size="12" /></span>
        <span class="body" :title="row.text">{{ short(row.text) }}</span>
        <span class="meta">
          <span v-if="row.time" class="time">{{ row.time }}</span>
          <button
            class="fork"
            :disabled="!canFork(row) || loading"
            :title="canFork(row) ? '从此条目分叉：后续对话在该点 reopen' : 'Pi 内核只允许从用户消息分叉'"
            @click.stop="fork(row.id)"
          >
            <AppIcon name="branch" :size="11" />
          </button>
        </span>
      </li>
    </ul>

    <div v-if="error" class="err">{{ error }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import { usePi } from '@/composables/usePi'
import { canFork, forkTargetId, iconOf, visibleNodes } from '@/composables/useSessionTree'
import type { FlatNode } from '@/composables/useSessionTree'

const props = defineProps<{ autoRefresh?: boolean }>()

const { nodes, refreshTree, forkFrom } = usePi()
const loading = ref(false)
const error = ref('')

/** 展示层过滤：内核重试写的空 assistant / context_edit 条目不上树（数据保留）。 */
const shown = computed(() => visibleNodes(nodes.value))

/** 内核在后台继续写会话时，树需要自己长出来；切走这个面板就停掉轮询。 */
const AUTO_INTERVAL = 15_000
let timer: ReturnType<typeof setInterval> | null = null

function startAuto() {
  if (timer) return
  timer = setInterval(() => {
    void refresh()
  }, AUTO_INTERVAL)
}

function stopAuto() {
  if (!timer) return
  clearInterval(timer)
  timer = null
}

const empty = computed(() => !loading.value && nodes.value.length === 0)
const forkable = computed(() => forkTargetId(nodes.value) !== null)

async function refresh() {
  loading.value = true
  error.value = ''
  try {
    await refreshTree()
  } catch (e) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

async function fork(id: string | undefined) {
  if (!id) return
  loading.value = true
  error.value = ''
  try {
    await forkFrom(id)
  } catch (e) {
    error.value = String(e)
  } finally {
    loading.value = false
  }
}

/** 分叉末端 = 重新打开最后一条 user message（Pi fork 语义，见 useSessionTree.canFork）。 */
function forkEnd() {
  const id = forkTargetId(nodes.value)
  if (id) void fork(id)
}

/**
 * 点击行分叉：Pi fork RPC 只接受 user message（内核硬约束），其余行点了给提示。
 */
function select(row: FlatNode) {
  if (row.isLeaf) return
  if (!canFork(row)) {
    error.value = '只能从用户消息分叉（Pi 内核约束）。'
    return
  }
  fork(row.id)
}

function short(text: string): string {
  const s = text.replace(/\s+/g, ' ').trim()
  return s.length > 60 ? `${s.slice(0, 60)}…` : s
}

onMounted(() => {
  if (!props.autoRefresh) return
  void refresh()
  startAuto()
})

onUnmounted(stopAuto)

watch(
  () => props.autoRefresh,
  (on) => {
    if (on) {
      void refresh()
      startAuto()
    } else {
      stopAuto()
    }
  },
)

defineExpose({ refresh })
</script>

<style src="./SessionTree.css" scoped></style>
