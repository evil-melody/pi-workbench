<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue: string
    placeholder?: string
    disabled?: boolean
    mono?: boolean
    rows?: number
    spellcheck?: boolean
    /** 随内容自动增高：grows with content, caps at maxRows. */
    autoGrow?: boolean
    maxRows?: number
  }>(),
  { mono: false, rows: 8, spellcheck: false, autoGrow: false, maxRows: 10 },
)

const emit = defineEmits<{ 'update:modelValue': [string] }>()

const el = ref<HTMLTextAreaElement | null>(null)

/** 挂载时把初始值灌进 DOM（此后 textarea 非受控，见下方 watch 说明）。 */
onMounted(() => {
  if (el.value) el.value.value = props.modelValue
})

/** 重算高度：先复位再取 scrollHeight，避免只增不减。 */
function resize() {
  const node = el.value
  if (!props.autoGrow || !node) return
  node.style.height = 'auto'
  const lh = parseFloat(getComputedStyle(node).lineHeight || '20') || 20
  const max = lh * props.maxRows
  node.style.height = `${Math.min(node.scrollHeight, max)}px`
  node.style.overflowY = node.scrollHeight > max ? 'auto' : 'hidden'
}

/**
 * 只做「外部 → DOM」的单向程序性同步（发送后清空、预填草稿）。
 *
 * 之前是全受控 `:value` 回填：每次按键都要等 emit → 父组件重渲 → patch
 * 才能回显，主线程被流式事件刷满时回显排队，表现为「打了半天字才蹦出来」。
 * 非受控后按键由浏览器即时上屏，emit 只负责把值同步给 v-model。
 */
watch(
  () => props.modelValue,
  (v) => {
    const node = el.value
    if (node && node.value !== v) {
      node.value = v
      nextTick(resize)
    }
  },
)
</script>

<template>
  <textarea
    ref="el"
    class="app-textarea"
    :class="{ mono: props.mono, grow: props.autoGrow }"
    :placeholder="props.placeholder"
    :disabled="props.disabled"
    :rows="props.rows"
    :spellcheck="props.spellcheck"
    @input="[
      emit('update:modelValue', ($event.target as HTMLTextAreaElement).value),
      resize(),
    ]"
  ></textarea>
</template>

<style src="./AppTextarea.css" scoped></style>
