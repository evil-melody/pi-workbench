<script setup lang="ts">
import { t } from '@/i18n'
/**
 * 文件编辑面板：读工作目录里的文件、就地改、写回磁盘。
 *
 * 为什么抽出来：对话页与项目工作台都要看文件。这份逻辑（读/改/存 + 重载、
 * 复制路径、外部打开）原来只长在对话页里，第二个用它的页面就只能再抄一遍。
 */
import { ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppTextarea from '@/components/ui/AppTextarea.vue'
import { fsReadFile, fsWriteFile } from '@/composables/useFs'
import { officeToHtml } from '@/composables/useOfficePreview'
import { sanitizeHtml } from '@/utils/sanitizeHtml'
import type { ArtifactContent } from '@/composables/useArtifacts'

const props = defineProps<{
  /** 文件所属的工作目录。 */
  root: string
  /** 选中的文件路径；空 = 还没选文件。 */
  path?: string | null
}>()

const content = ref('')
const dirty = ref(false)
const hint = ref('')
const officeHtml = ref('')
const isOffice = ref(false)

const OFFICE_EXT = ['docx', 'xlsx', 'pptx', 'pdf']

async function load(path: string) {
  hint.value = ''
  dirty.value = false
  officeHtml.value = ''
  isOffice.value = false
  if (!path) {
    content.value = ''
    return
  }
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  if (OFFICE_EXT.includes(ext)) {
    try {
      const res = await invoke<ArtifactContent>('artifacts_read', { root: props.root, path })
      officeHtml.value = sanitizeHtml(await officeToHtml(res.kind, res.content))
      isOffice.value = true
    } catch (e) {
      isOffice.value = false
      hint.value = t('{0}；可用「外部打开」查看原件', [String(e)])
    }
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
  hint.value = t('已重新读取磁盘内容')
}

async function copyPath() {
  if (!props.path) return
  try {
    await navigator.clipboard.writeText(props.path)
    hint.value = t('路径已复制')
  } catch {
    hint.value = t('浏览器拒绝了剪贴板访问，请手动复制')
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
    hint.value = t('已保存')
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
        <AppButton v-if="!isOffice" variant="text" size="sm" class="fbar-action" :title="t('重新读取磁盘内容')" @click="reload">
          <AppIcon name="refresh" :size="12" />
          <span>{{ t('重载') }}</span>
        </AppButton>
        <AppButton variant="text" size="sm" class="fbar-action" :title="t('复制绝对路径')" @click="copyPath">
          <AppIcon name="copy" :size="12" />
          <span>{{ t('复制路径') }}</span>
        </AppButton>
        <AppButton variant="text" size="sm" class="fbar-action" :title="t('用系统默认应用打开')" @click="openExternally">
          <AppIcon name="external" :size="12" />
          <span>{{ t('外部打开') }}</span>
        </AppButton>
        <AppButton v-if="!isOffice" variant="primary" size="sm" class="fbar-action primary" :disabled="!dirty" :title="t('写回磁盘')" @click="save">
          <AppIcon name="save" :size="12" />
          <span>{{ t('保存') }}</span>
        </AppButton>
      </div>
      <p v-if="hint" class="file-hint">{{ hint }}</p>
      <AppTextarea v-if="!isOffice" v-model="content" class="editor" mono @input="dirty = true" />
      <div v-else class="office-preview">
        <p class="office-caveat">{{ t('只读预览：还原阅读版式，不承诺与 Office 逐项保真') }}</p>
        <div class="office" v-html="officeHtml"></div>
      </div>
    </template>

    <div v-else class="empty-pane">
      <AppIcon name="file" :size="32" />
      <strong>{{ t('从左侧文件树选择文件') }}</strong>
      <span class="muted">{{ t('选中后在这里编辑与保存。') }}</span>
    </div>
  </div>
</template>

<style src="./FileEditorPane.css" scoped></style>
