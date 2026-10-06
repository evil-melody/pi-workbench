<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { marked } from 'marked'
import {
  isOfficeKind,
  openExternal,
  readArtifact,
  type Artifact,
  type ArtifactContent,
} from '@/composables/useArtifacts'
import { officeToHtml } from '@/composables/useOfficePreview'
import { IN_TAURI } from '@/composables/usePi'

const props = defineProps<{ artifact: Artifact; root: string }>()
const emit = defineEmits<{ close: [] }>()

const content = ref<ArtifactContent | null>(null)
const error = ref('')
const loading = ref(false)
const officeHtml = ref('')
const opening = ref(false)

const rendered = computed(() => {
  const c = content.value
  if (!c) return ''
  if (c.kind === 'markdown') return marked.parse(c.content, { breaks: true }) as string
  if (c.kind === 'json') {
    try {
      return `<pre class="raw">${JSON.stringify(JSON.parse(c.content), null, 2)}</pre>`
    } catch {
      return `<pre class="raw">${escapeHtml(c.content)}</pre>`
    }
  }
  return ''
})

function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    content.value = await readArtifact(props.root, props.artifact)
    officeHtml.value = ''
    if (!content.value) return
    if (isOfficeKind(content.value.kind)) {
      officeHtml.value = await officeToHtml(content.value.kind, content.value.content)
    }
  } catch (e) {
    // 二进制、超大文件等拒绝读取的情况直接给可读原因，不抛底层错误码。
    error.value = e instanceof Error ? e.message : String(e)
    content.value = null
  } finally {
    loading.value = false
  }
}

async function onOpenExternal() {
  opening.value = true
  try {
    await openExternal(props.artifact.path)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    opening.value = false
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
  void load()
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
watch(() => props.artifact.path, load)
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="dialog">
      <header>
        <span class="title" :title="artifact.path">{{ artifact.name }}</span>
        <span class="path">{{ artifact.path }}</span>
        <button
          class="ext"
          :disabled="opening || !IN_TAURI"
          :title="IN_TAURI ? '用系统默认应用打开' : '仅桌面 App 可调用系统应用'"
          @click="onOpenExternal"
        >
          {{ opening ? '打开中…' : '用外部应用打开' }}
        </button>
        <button class="close" title="关闭 (Esc)" @click="emit('close')">✕</button>
      </header>

      <div v-if="content && isOfficeKind(content.kind)" class="caveat">
        只读预览：还原阅读版式，<b>不承诺与 Office 逐项保真</b>。复杂排版请用「用外部应用打开」。
      </div>

      <div class="stage">
        <div v-if="loading" class="state">读取中…</div>
        <div v-else-if="error" class="state err">{{ error }}</div>
        <div v-else-if="!content" class="state">没有可预览的内容</div>

        <iframe
          v-else-if="content.kind === 'html' || content.kind === 'svg'"
          class="frame"
          :srcdoc="content.content"
          sandbox=""
          title="预览"
        ></iframe>

        <img
          v-else-if="content.kind === 'image'"
          class="img"
          :src="content.content"
          :alt="artifact.name"
        />

        <div v-else-if="isOfficeKind(content.kind)" class="office" v-html="officeHtml"></div>

        <div v-else-if="content.kind === 'markdown'" class="md" v-html="rendered"></div>
        <div v-else class="md" v-html="rendered"></div>

        <p v-if="content?.truncated" class="trunc">
          内容超过 512 KB，已截断显示。完整文件请在右侧编辑器中打开。
        </p>
      </div>
    </div>
  </div>
</template>

<style src="./ArtifactPreview.css" scoped></style>
