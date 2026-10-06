<template>
  <div class="sess">
    <div class="bar">
      <button :disabled="loading" @click="refresh">
        <AppIcon name="refresh" :size="12" />
        <span>刷新</span>
      </button>
      <button :disabled="!forkable || loading" @click="fork(forkTarget(leafId))" title="从当前分支末端继续">
        分叉末端
      </button>
      <span class="count">{{ nodes.length }} 条</span>
    </div>

    <div v-if="empty" class="empty">暂无会话条目。发起一次对话后，这里会长出分支树。</div>

    <ul v-else class="rows">
      <li
        v-for="row in nodes"
        :key="row.id"
        class="row"
        :class="[{ leaf: row.isLeaf, user: row.role === 'user' }, row.kind]"
        :style="{ paddingLeft: `${8 + row.depth * 14}px` }"
        @click="select(row)"
      >
        <span class="icon">{{ iconOf(row.kind) }}</span>
        <span class="body" :title="row.text">{{ short(row.text) }}</span>
        <span class="meta">
          <span v-if="row.time" class="time">{{ row.time }}</span>
          <button
            class="fork"
            title="从此条目分叉：后续对话在该点 reopen"
            @click.stop="fork(row.id)"
          >⑂</button>
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
import { iconOf } from '@/composables/useSessionTree'
import type { FlatNode } from '@/composables/useSessionTree'

const props = defineProps<{ autoRefresh?: boolean }>()

const { nodes, tree, refreshTree, forkFrom } = usePi()
const loading = ref(false)
const error = ref('')

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

const leafId = computed(() => tree.value.leafId)
const empty = computed(() => !loading.value && nodes.value.length === 0)
const forkable = computed(() => !!leafId.value)

function forkTarget(id: string | null): string | undefined {
  return id ?? undefined
}

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

/** 点击非叶节点即分叉到它；点叶节点无意义（已在末端）。 */
function select(row: FlatNode) {
  if (row.isLeaf) return
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
