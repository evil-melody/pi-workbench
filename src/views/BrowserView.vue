<script setup lang="ts">
import { t } from '@/i18n'
/**
 * 浏览器会话（打开 / 抓取 / 截图能力的操作入口）。
 * 读取 `agent_browser_status`；打开走 `agent_browser_open`（在用户真实浏览器中跳转，
 * 对应的「抓取 / 截图」能力由 Pi 工具 `browser_fetch`/`browser_screenshot` 提供）。
 */
import { computed, onMounted, ref } from 'vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import RuntimeNote from '@/components/runtime/RuntimeNote.vue'
import { agentBrowserStatus, agentBrowserOpen, type BrowserStatus } from '@/composables/useAgentOps'

defineProps<{ embedded?: boolean }>()

const status = ref<BrowserStatus>({ active: false })
const busy = ref(false)
const url = ref('')
const msg = ref('')
const msgError = ref(false)

const lastAt = computed(() => {
  const at = status.value?.at
  if (!at) return ''
  const d = Date.now() - at
  if (d < 60_000) return t('刚刚')
  if (d < 3_600_000) return t('{0} 分钟前', [Math.floor(d / 60_000)])
  return new Date(at).toLocaleString()
})

async function refresh() {
  busy.value = true
  msg.value = ''
  msgError.value = false
  try {
    status.value = await agentBrowserStatus()
  } catch (e) {
    msg.value = String(e)
    msgError.value = true
  }
  busy.value = false
}

async function open() {
  const u = url.value.trim()
  if (!/^https?:\/\//.test(u)) {
    msg.value = t('请输入以 http(s):// 开头的网址')
    msgError.value = true
    return
  }
  try {
    const r = await agentBrowserOpen(u)
    msg.value = r.opened ? t('已在浏览器打开 {0}', [u]) : t('打开失败')
    msgError.value = !r.opened
    url.value = ''
    await refresh()
  } catch (e) {
    msg.value = String(e)
    msgError.value = true
  }
}

onMounted(refresh)
</script>

<template>
  <section class="agent-ops browser" :class="{ embedded }">
    <RuntimeNote />

    <header class="aops-head">
      <div class="aops-title">
        <h1>{{ t('浏览器自动化') }}</h1>
        <p class="muted">{{ t('在桌面浏览器中打开网页，或交给对话里的') }}<code>browser_fetch</code> / <code>browser_screenshot</code>{{ t('做页面抓取与无头截图。') }}</p>
      </div>
      <div class="aops-meta">
        <AppButton variant="icon" class="tool-btn" :disabled="busy" :title="t('刷新')" @click="refresh()">
          <AppIcon name="refresh" :size="14" />
        </AppButton>
      </div>
    </header>

    <div class="aops-toolbar">
      <div class="url-box">
        <AppIcon name="external" :size="14" />
        <!-- AUDIT-004：原生 input → UI Kit AppInput（v-model + enter 行为不变） -->
        <AppInput v-model="url" class="url-input" placeholder="https://example.com" @keyup.enter="open()" />
      </div>
      <AppButton variant="primary" class="btn primary" :disabled="busy" @click="open()">
        <AppIcon name="monitor" :size="14" />{{ t('打开') }}</AppButton>
      <span v-if="msg" class="aops-status" :class="{ err: msgError }">{{ msg }}</span>
    </div>

    <div v-if="status.active" class="sess-card">
      <div class="sess-row">
        <AppIcon name="monitor" :size="15" />
        <span class="sess-label">{{ t('当前会话') }}</span>
        <span class="sess-dot" />
        <span class="sess-state">{{ t('活跃') }}</span>
      </div>
      <div class="sess-url">
        <a :href="status.url" target="_blank" rel="noopener">{{ status.url }}</a>
      </div>
      <div class="sess-meta">
        <span>{{ t('方式：{0}', [status.method ?? '—']) }}</span>
        <span v-if="lastAt">{{ t('最近：{0}', [lastAt]) }}</span>
      </div>
    </div>

    <div v-else class="aops-empty">
      <AppIcon name="monitor" :size="36" />
      <strong>{{ t('没有进行中的浏览器会话') }}</strong>
      <span class="muted">{{ t('输入网址点「打开」即可在本地浏览器跳转；抓取类能力在对话里用') }}<code>/browser</code>{{ t('触发。') }}</span>
    </div>
  </section>
</template>

<style src="./BrowserView.css" scoped></style>
