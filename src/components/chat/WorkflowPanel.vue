<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import { parseTodoList } from '@/utils/todoList'
import type { ActivityState } from '@/composables/useActivity'
import type { PiMsg } from '@/composables/usePi'

const props = defineProps<{
  state: ActivityState
  running: boolean
  messages: PiMsg[]
}>()

/**
 * 任务清单来自 Pi 自己在回复里写的 markdown 复选框（`- [x]` / `- [ ]`）。
 * 这样面板显示的是本轮真实任务，而不是写死的四个阶段；
 * 内核暂无独立的 todo 协议，因此不做回写——勾选只存在于本面板视图里。
 */
const tasks = computed(() => parseTodoList(props.messages))

/** 文本 → 已勾选：初始取自 Pi 的勾选结果；用户改动只覆盖同名的条目。 */
const checked = ref<Record<string, boolean>>({})
const dirtyTasks = ref(new Set<string>())

watch(
  tasks,
  (list) => {
    const next: Record<string, boolean> = {}
    for (const t of list) {
      next[t.text] = dirtyTasks.value.has(t.text) ? checked.value[t.text] : t.done
    }
    checked.value = next
  },
  { immediate: true },
)

const doneCount = computed(() => tasks.value.filter((t) => checked.value[t.text]).length)

function toggle(t: (typeof tasks.value)[number]) {
  dirtyTasks.value.add(t.text)
  checked.value = { ...checked.value, [t.text]: !checked.value[t.text] }
}

function reset() {
  dirtyTasks.value = new Set()
  checked.value = Object.fromEntries(tasks.value.map((t) => [t.text, t.done]))
}

function isDone(text: string) {
  return !!checked.value[text]
}
</script>

<template>
  <div class="workflow-panel">
    <div class="panel-head">
      <AppIcon name="list" :size="14" />
      <span>工作流</span>
      <span v-if="tasks.length" class="count">{{ doneCount }}/{{ tasks.length }}</span>
      <button v-if="dirtyTasks.size" class="reset" title="还原 Pi 的勾选结果" @click="reset">
        <AppIcon name="refresh" :size="12" />
      </button>
    </div>

    <ul v-if="tasks.length" class="todo-list">
      <li
        v-for="t in tasks"
        :key="t.id"
        class="todo"
        :class="{ done: isDone(t.text), active: props.running && !isDone(t.text) }"
        @click="toggle(t)"
      >
        <span class="check">
          <AppIcon v-if="isDone(t.text)" name="check" :size="12" />
        </span>
        <span class="text">{{ t.text }}</span>
        <span v-if="t.done" class="from-pi" title="Pi 原始勾选结果">内核</span>
      </li>
    </ul>

    <p v-else class="note">
      本轮回复里还没有任务清单。Pi 一旦在回答中写出
      <code>- [ ] 待办</code> 形式的清单，条目会自动出现在这里。
    </p>

    <p class="note">
      勾选只作用于当前视图，不会回写内核；真实任务状态以 Pi 的输出为准。
    </p>
  </div>
</template>

<style src="./WorkflowPanel.css" scoped></style>
