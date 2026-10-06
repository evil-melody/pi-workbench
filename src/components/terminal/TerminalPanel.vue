<template>
  <div class="term">
    <div class="term-head">
      <span class="cwd" :title="props.cwd">{{ props.cwd }}</span>
      <span v-if="running" class="state running">
        <AppIcon name="spinner" :size="11" class="spin" />
        执行中
      </span>
      <button class="term-btn" title="清空输出" @click="clear">
        <AppIcon name="trash" :size="12" />
      </button>
    </div>

    <div ref="out" class="out">
      <div v-for="(l, i) in lines" :key="i" :class="['ln', l.stream]">{{ l.line }}</div>
      <p v-if="!lines.length && !running" class="out-empty">在项目目录执行 shell 命令，输出会实时回显。</p>
    </div>

    <form class="cin" @submit.prevent="run">
      <span class="ps">$</span>
      <AppInput
        v-model="cmd"
        class="tinput"
        :placeholder="running ? '执行中…' : '在项目目录执行 shell 命令'"
        @keydown.up.prevent="recall(-1)"
        @keydown.down.prevent="recall(1)"
      />
    </form>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { useTerminal } from '@/composables/useTerminal'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppInput from '@/components/ui/AppInput.vue'

const props = defineProps<{ cwd: string }>()
const { lines, running, ensure, exec, clear } = useTerminal(() => props.cwd)
const cmd = ref('')
const out = ref<HTMLElement | null>(null)

/** ↑/↓  recalls history；游标停在 -1 表示正在编辑新命令。 */
const history: string[] = []
let cursor = -1

onMounted(ensure)

async function run() {
  const c = cmd.value.trim()
  if (!c || running.value) return
  if (history[history.length - 1] !== c) history.push(c)
  cursor = -1
  cmd.value = ''
  await exec(c)
  await nextTick()
  const el = out.value
  if (el) el.scrollTop = el.scrollHeight
}

function recall(step: 1 | -1) {
  if (!history.length) return
  cursor = Math.min(history.length - 1, Math.max(-1, cursor + step))
  cmd.value = cursor < 0 ? '' : history[history.length - 1 - cursor]
}
</script>

<style src="./TerminalPanel.css" scoped></style>
