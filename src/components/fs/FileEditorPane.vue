<script setup lang="ts">
/**
 * 文件编辑面板：读工作目录里的文件、就地改、写回磁盘。
 *
 * 为什么抽出来：对话页与项目工作台都要看文件。这份逻辑（读/改/存 + 重载、
 * 复制路径、外部打开）原来只长在对话页里，第二个用它的页面就只能再抄一遍。
 */
import { ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppTextarea from '@/components/ui/AppTextarea.vue'
import { fsReadFile, fsWriteFile } from '@/composables/useFs'

const props = defineProps<{
  /** 文件所属的工作目录。 */
  root: string
  /** 选中的文件路径；空 = 还没选文件。 */
  path?: string | null
}>()

const content = ref('')
const dirty = ref(false)
const hint = ref('')

async function load(path: string) {
  hint.value = ''
  dirty.value = false
  if (!path) {
    content.value = ''
    return
  }
  content.value = await fsReadFile(path, props.root).catch((e) => {
    hint.value = String(e)
    return ''
  })
}

// 换文件、换工作目录都要重新读盘：否则会拿着上一个项目的内容写回新项目。
watch(
  () => [props.path, props.root],
  () => void load(props.path ?? ''),
  { immediate: true },
)

async function reload() {
  if (!props.path) return
  const next = await fsReadFile(props.path, props.root).catch((e) => {
    hint.value = String(e)
    return null
  })
  if (next === null) return
  content.value = next
  dirty.value = false
  hint.value = '已重新读取磁盘内容'
}

async function copyPath() {
  if (!props.path) return
  try {
    await navigator.clipboard.writeText(props.path)
    hint.value = '路径已复制'
  } catch {
    hint.value = '浏览器拒绝了剪贴板访问，请手动复制'
  }
}

async function openExternally() {
  if (!props.path) return
  try {
    await invoke('artifacts_open', { path: props.path })
  } catch (e) {
    hint.value = String(e)
  }
}

async function save() {
  if (!props.path) return
  try {
    await fsWriteFile(props.path, content.value, props.root)
    dirty.value = false
    hint.value = '已保存'
  } catch (e) {
    hint.value = String(e)
  }
}
</script>

<template>
  <div class="fedit">
    <template v-if="path">
      <div class="fbar">
        <span class="fpath" :title="path">{{ path }}</span>
        <button class="fbar-action" title="重新读取磁盘内容" @click="reload">
          <AppIcon name="refresh" :size="12" />
          <span>重载</span>
        </button>
        <button class="fbar-action" title="复制绝对路径" @click="copyPath">
          <AppIcon name="copy" :size="12" />
          <span>复制路径</span>
        </button>
        <button class="fbar-action" title="用系统默认应用打开" @click="openExternally">
          <AppIcon name="external" :size="12" />
          <span>外部打开</span>
        </button>
        <button class="fbar-action primary" :disabled="!dirty" title="写回磁盘" @click="save">
          <AppIcon name="save" :size="12" />
          <span>保存</span>
        </button>
      </div>
      <p v-if="hint" class="file-hint">{{ hint }}</p>
      <AppTextarea v-model="content" class="editor" mono @input="dirty = true" />
    </template>

    <div v-else class="empty-pane">
      <AppIcon name="file" :size="32" />
      <strong>从左侧文件树选择文件</strong>
      <span class="muted">选中后在这里编辑与保存。</span>
    </div>
  </div>
</template>

<style src="./FileEditorPane.css" scoped></style>
