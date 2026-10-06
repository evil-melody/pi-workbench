<script setup lang="ts">
/**
 * 浏览器会话（打开 / 抓取 / 截图能力的操作入口）。
 * 读取 `agent_browser_status`；打开走 `agent_browser_open`（在用户真实浏览器中跳转，
 * 对应的「抓取 / 截图」能力由 Pi 工具 `browser_fetch`/`browser_screenshot` 提供）。
 */
import { computed, onMounted, ref } from 'vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import RuntimeNote from '@/components/runtime/RuntimeNote.vue'
import { agentBrowserStatus, agentBrowserOpen, type BrowserStatus } from '@/composables/useAgentOps'

defineProps<{ embedded?: boolean }>()

const status = ref<BrowserStatus>({ active: false })
const busy = ref(false)
const url = ref('')
const msg = ref('')

const lastAt = computed(() => {
  const t = status.value?.at
  if (!t) return ''
  const d = Date.now() - t
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`
  return new Date(t).toLocaleString()
})

async function refresh() {
  busy.value = true
  msg.value = ''
  try {
    status.value = await agentBrowserStatus()
  } catch (e) {
    msg.value = String(e)
  }
  busy.value = false
}

async function open() {
  const u = url.value.trim()
  if (!/^https?:\/\//.test(u)) {
    msg.value = '请输入以 http(s):// 开头的网址'
    return
  }
  try {
    const r = await agentBrowserOpen(u)
    msg.value = r.opened ? `已在浏览器打开 ${u}` : '打开失败'
    url.value = ''
    await refresh()
  } catch (e) {
    msg.value = String(e)
  }
}

onMounted(refresh)
</script>

<template>
  <section class="agent-ops browser" :class="{ embedded }">
    <RuntimeNote />

    <header class="aops-head">
      <div class="aops-title">
        <h1>浏览器自动化</h1>
        <p class="muted">在桌面浏览器中打开网页，或交给对话里的 <code>browser_fetch</code> / <code>browser_screenshot</code> 做页面抓取与无头截图。</p>
      </div>
      <div class="aops-meta">
        <button class="tool-btn" :disabled="busy" title="刷新" @click="refresh()">
          <AppIcon name="refresh" :size="14" />
        </button>
      </div>
    </header>

    <div class="aops-toolbar">
      <div class="url-box">
        <AppIcon name="external" :size="14" />
        <input v-model="url" class="url-input" placeholder="https://example.com" @keyup.enter="open()" />
      </div>
      <button class="btn primary" :disabled="busy" @click="open()">
        <AppIcon name="monitor" :size="14" /> 打开
      </button>
      <span v-if="msg" class="aops-status" :class="{ err: msg.startsWith('请') || msg.startsWith('输入') }">{{ msg }}</span>
    </div>

    <div v-if="status.active" class="sess-card">
      <div class="sess-row">
        <AppIcon name="monitor" :size="15" />
        <span class="sess-label">当前会话</span>
        <span class="sess-dot" />
        <span class="sess-state">活跃</span>
      </div>
      <div class="sess-url">
        <a :href="status.url" target="_blank" rel="noopener">{{ status.url }}</a>
      </div>
      <div class="sess-meta">
        <span>方式：{{ status.method ?? '—' }}</span>
        <span v-if="lastAt">最近：{{ lastAt }}</span>
      </div>
    </div>

    <div v-else class="aops-empty">
      <AppIcon name="monitor" :size="36" />
      <strong>没有进行中的浏览器会话</strong>
      <span class="muted">输入网址点「打开」即可在本地浏览器跳转；抓取类能力在对话里用 <code>/browser</code> 触发。</span>
    </div>
  </section>
</template>

<style src="./BrowserView.css" scoped></style>
