<script setup lang="ts">
import { t } from '@/i18n'
import { computed, onMounted, ref, watch } from 'vue'
import { marked } from 'marked'
import {
  isOfficeKind,
  openExternal,
  readArtifact,
  saveArtifactAs,
  type Artifact,
  type ArtifactContent,
} from '@/composables/useArtifacts'
import { officeToHtml } from '@/composables/useOfficePreview'
import { IN_TAURI } from '@/composables/usePi'
import { sanitizeHtml } from '@/utils/sanitizeHtml'
import AppModal from '@/components/ui/AppModal.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'

const props = defineProps<{ artifact: Artifact; root: string }>()
const emit = defineEmits<{ close: []; quote: [Artifact] }>()

const content = ref<ArtifactContent | null>(null)
const error = ref('')
const loading = ref(false)
const officeHtml = ref('')
const opening = ref(false)
const saving = ref(false)
/** #66 M9：预览/源码双视图。有源码（文本类读取成功）才可切。 */
const view = ref<'preview' | 'code'>('preview')
/** 动作键的瞬时回显（复制/保存成功），1.5s 自清。 */
const acted = ref('')
let actTimer: ReturnType<typeof setTimeout> | null = null

function flash(kind: string) {
  acted.value = kind
  if (actTimer) clearTimeout(actTimer)
  actTimer = setTimeout(() => (acted.value = ''), 1500)
}

/** 文本类源码（预览/代码切换与「复制代码」用）：图片与 office 是字节流，没有源码可看。 */
const codeText = computed(() => {
  const c = content.value
  if (!c) return ''
  if (c.kind === 'image' || isOfficeKind(c.kind)) return ''
  return c.content
})
const canCode = computed(() => codeText.value !== '')
/** 图片的 data URL（「复制图片」「保存图片」用）。 */
const dataUrl = computed(() => (content.value?.kind === 'image' ? content.value.content : ''))

const rendered = computed(() => {
  const c = content.value
  if (!c) return ''
  // AUDIT-012②：markdown 渲染结果过白名单消毒器再进 v-html——
  // artifact 内容来自内核/磁盘，不可信，marked 输出不做净化就是 XSS 面。
  if (c.kind === 'markdown') return sanitizeHtml(marked.parse(c.content, { breaks: true }) as string)
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
  view.value = 'preview'
  try {
    content.value = await readArtifact(props.root, props.artifact)
    officeHtml.value = ''
    if (!content.value) return
    if (isOfficeKind(content.value.kind)) {
      // office 还原 HTML 同样来自不可信文件内容，过同一道消毒器再 v-html。
      officeHtml.value = sanitizeHtml(await officeToHtml(content.value.kind, content.value.content))
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

/** 引用：把产物路径摘进托盘（父级落 pendingQuotes），按钮给瞬时回显。 */
function onQuote() {
  emit('quote', props.artifact)
  flash('quoted')
}

/** 复制代码：源码文本进剪贴板。 */
async function onCopyCode() {
  if (!codeText.value) return
  try {
    await navigator.clipboard.writeText(codeText.value)
    flash('code-copied')
  } catch {
    flash('copy-failed')
  }
}

/**
 * 复制图片：data URL 解码成 PNG blob 走 ClipboardItem（和真图粘贴进
 * 微信/Figma 同语义）；浏览器拒绝写图像时退回写 data URL 文本，至少不空手。
 */
async function onCopyImage() {
  if (!dataUrl.value) return
  try {
    const blob = await (await fetch(dataUrl.value)).blob()
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })])
    flash('image-copied')
  } catch {
    try {
      await navigator.clipboard.writeText(dataUrl.value)
      flash('image-copied')
    } catch {
      flash('copy-failed')
    }
  }
}

/**
 * 保存：产物本来就是磁盘文件，统一走系统保存对话框 → Rust 拷贝
 * （#66 M9「保存到本地」）。图片不单独走 <a download>：WKWebView 对
 * download 属性支持不可靠，一条路径比两条半残的路径更诚实。
 */
async function onSaveAs() {
  if (saving.value) return
  saving.value = true
  try {
    const dest = await saveArtifactAs(props.artifact)
    if (dest) flash('saved')
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

onMounted(() => {
  void load()
})
watch(() => props.artifact.path, load)
</script>

<template>
  <!-- AUDIT-012①：手搓 overlay → UI Kit AppModal（xl 尺寸，继承焦点陷阱与 Esc 全局关闭） -->
  <AppModal :open="true" :title="artifact.name" size="xl" @close="emit('close')">
    <div class="ap-bar">
      <span class="path" :title="artifact.path">{{ artifact.path }}</span>
      <!-- #66 M9 视图切换：预览 ↔ 源码（文本类才有） -->
      <div v-if="canCode" class="ap-seg">
        <AppButton
          variant="icon"
          class="ap-seg-btn"
          :class="{ on: view === 'preview' }"
          :title="t('预览')"
          @click="view = 'preview'"
        >
          <AppIcon name="eye" :size="13" />
          <span>{{ t('预览') }}</span>
        </AppButton>
        <AppButton
          variant="icon"
          class="ap-seg-btn"
          :class="{ on: view === 'code' }"
          :title="t('查看代码')"
          @click="view = 'code'"
        >
          <AppIcon name="code" :size="13" />
          <span>{{ t('代码') }}</span>
        </AppButton>
      </div>
      <!-- #66 M9 动作组：引用 / 复制 / 保存 / 外部打开 -->
      <AppButton variant="secondary" class="ap-act" :title="t('添加到对话')" @click="onQuote">
        <AppIcon name="quote" :size="13" />
        <span>{{ acted === 'quoted' ? t('已添加') : t('引用') }}</span>
      </AppButton>
      <AppButton
        v-if="content?.kind === 'image'"
        variant="secondary"
        class="ap-act"
        :disabled="!dataUrl"
        :title="t('复制图片')"
        @click="onCopyImage"
      >
        <AppIcon name="copy" :size="13" />
        <span>{{ acted === 'image-copied' ? t('已复制') : t('复制') }}</span>
      </AppButton>
      <AppButton
        v-else-if="canCode"
        variant="secondary"
        class="ap-act"
        :title="t('复制代码')"
        @click="onCopyCode"
      >
        <AppIcon name="copy" :size="13" />
        <span>{{ acted === 'code-copied' ? t('已复制') : t('复制') }}</span>
      </AppButton>
      <AppButton
        v-if="content"
        variant="secondary"
        class="ap-act"
        :disabled="saving || !IN_TAURI"
        :title="IN_TAURI ? t('保存到本地…') : t('仅桌面 App 可保存到本地')"
        @click="onSaveAs"
      >
        <AppIcon name="download" :size="13" />
        <span>{{ saving ? t('保存中…') : acted === 'saved' ? t('已保存') : t('保存') }}</span>
      </AppButton>
      <AppButton
        variant="secondary"
        class="ext"
        :disabled="opening || !IN_TAURI"
        :title="IN_TAURI ? t('用系统默认应用打开') : t('仅桌面 App 可调用系统应用')"
        @click="onOpenExternal"
      >
        {{ opening ? t('打开中…') : t('用外部应用打开') }}
      </AppButton>
    </div>
    <p v-if="acted === 'copy-failed'" class="ap-note" role="status">{{ t('复制失败：剪贴板被系统拒绝') }}</p>

    <div v-if="content && isOfficeKind(content.kind)" class="caveat">{{ t('只读预览：还原阅读版式，') }}<b>{{ t('不承诺与 Office 逐项保真') }}</b>{{ t('。复杂排版请用「用外部应用打开」。') }}</div>

    <div class="stage">
      <div v-if="loading" class="state">{{ t('读取中…') }}</div>
      <div v-else-if="error" class="state err">{{ error }}</div>
      <div v-else-if="!content" class="state">{{ t('没有可预览的内容') }}</div>

      <!-- 源码视图：文本类产物统一 <pre class="raw">，不解析不渲染 -->
      <pre v-else-if="view === 'code'" class="raw ap-code">{{ codeText }}</pre>

      <iframe
        v-else-if="content.kind === 'html' || content.kind === 'svg'"
        class="frame"
        :srcdoc="content.content"
        sandbox=""
        :title="t('预览')"
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

      <p v-if="content?.truncated" class="trunc">{{ t('内容超过 512 KB，已截断显示。完整文件请用上方「用外部应用打开」查看。') }}</p>
    </div>
  </AppModal>
</template>

<style src="./ArtifactPreview.css" scoped></style>
