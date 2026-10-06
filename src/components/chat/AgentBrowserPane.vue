<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { invoke } from '@tauri-apps/api/core'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppInput from '@/components/ui/AppInput.vue'
import { IN_TAURI } from '@/composables/usePi'
import { usePiEventsInjected } from '@/composables/usePiEvents'
import { EVENT_KIND_ICON, EVENT_KIND_LABEL, type PiEventRow } from '@/utils/piEventKind'

const props = defineProps<{ streaming?: boolean }>()

// 会话页共享同一条缓冲：面板可能被反复挂载，各自订阅会重复消费同一事件。
const stream = usePiEventsInjected()
const events = computed<PiEventRow[]>(() => stream?.events.value ?? [])
const stats = computed(() => stream?.stats.value ?? { total: 0, calls: 0, turns: 0, exits: 0 })
const ensure = () => stream?.ensure()
const note = (title: string, detail = '') => stream?.note(title, detail)

const address = ref('')
const text = ref('')
const compact = ref(false)
/** 访问过的地址，按顺序；用于「返回」——面板没有内嵌 WebView，回退作用于本面板视图。 */
const history = ref<string[]>([])
const scroller = ref<HTMLElement | null>(null)

const rows = computed<PiEventRow[]>(() => events.value)
const canBack = computed(() => history.value.length > 1)
const currentUrl = computed(() => history.value[history.value.length - 1] ?? '')

onMounted(ensure)

/** 新事件到达后贴住底部，避免用户要手动滚。 */
watch(
  () => events.value.length,
  async () => {
    await nextTick()
    const el = scroller.value
    if (el) el.scrollTop = el.scrollHeight
  },
)

async function submitAddress(e: Event) {
  e.preventDefault()
  const raw = address.value.trim()
  if (!raw) return
  address.value = ''
  if (!IN_TAURI) {
    note('目标地址（浏览器模式，未打开）', raw)
    return
  }
  try {
    const opened = await invoke<string>('browser_open', { url: raw })
    history.value = [...history.value.filter((h) => h !== opened), opened]
    note('目标地址', opened)
  } catch (err) {
    note('目标地址被拒绝', String(err))
  }
}

function back() {
  if (!canBack.value) return
  history.value = history.value.slice(0, -1)
  note('返回上一个地址', currentUrl.value)
}

function submitText(e: Event) {
  e.preventDefault()
  const t = text.value.trim()
  if (!t) return
  note('页面输入', t)
  text.value = ''
}

function refresh() {
  stream?.reset()
}
</script>

<template>
  <section class="agent-browser" aria-label="智能体浏览器">
    <header class="browser-head">
      <div class="browser-title">
        <span class="live-dot" :class="{ on: props.streaming }" />
        <strong>智能体浏览器</strong>
        <span class="live-meta">{{ stats.calls }} 次调用 · {{ stats.turns }} 轮</span>
      </div>
      <div class="browser-actions">
        <button type="button" title="返回上一个地址" :disabled="!canBack" @click="back">
          <AppIcon name="chevron-left" :size="14" />
        </button>
        <button type="button" title="清空事件流" @click="refresh">
          <AppIcon name="refresh" :size="14" />
        </button>
        <button type="button" @click="compact = !compact" title="切换紧凑显示">
          {{ compact ? '标准行距' : '紧凑行距' }}
        </button>
      </div>
    </header>

    <form class="browser-toolbar" @submit="submitAddress">
      <AppInput v-model="address" placeholder="https://" mono class="address-input" />
      <button type="submit" class="toolbar-btn" :disabled="!address.trim()">前往</button>
    </form>

    <div ref="scroller" class="browser-viewport" :class="{ compact }">
      <p v-if="currentUrl" class="browser-url" :title="currentUrl">
        <AppIcon name="monitor" :size="12" /> {{ currentUrl }}
      </p>

      <p v-if="!rows.length && !props.streaming" class="browser-placeholder">
        <AppIcon name="monitor" :size="36" />
        <span class="hint">等待智能体动作…</span>
        <span class="sub">内核启动后，工具调用与轮次变化会实时出现在这里。</span>
      </p>

      <p v-else-if="!rows.length" class="browser-placeholder">
        <AppIcon name="spinner" :size="24" class="spin" />
        <span class="hint">智能体正在执行…</span>
      </p>

      <ol v-else class="event-log">
        <li v-for="(row, i) in rows" :key="i" class="ev" :data-kind="row.kind">
          <span class="ev-icon">
            <AppIcon :name="EVENT_KIND_ICON[row.kind]" :size="12" />
          </span>
          <div class="ev-body">
            <div class="ev-line">
              <span class="ev-kind">{{ EVENT_KIND_LABEL[row.kind] }}</span>
              <span class="ev-title">{{ row.title }}</span>
            </div>
            <p v-if="row.detail" class="ev-detail">{{ row.detail }}</p>
          </div>
          <time class="ev-time">{{ new Date(row.at).toLocaleTimeString('zh-CN', { hour12: false }) }}</time>
        </li>
      </ol>

      <div v-if="props.streaming" class="streaming-bar">
        <AppIcon name="spinner" :size="12" class="spin" />
        执行中…
      </div>
    </div>

    <form class="browser-input" @submit="submitText">
      <AppInput v-model="text" placeholder="点击网页输入框后，在此输入文本" class="text-input" />
      <button type="submit" class="toolbar-btn" :disabled="!text.trim()">输入</button>
    </form>

    <p class="browser-hint">
      画面没有内嵌 WebView：<strong>前往</strong> 会用系统默认浏览器打开，返回仅回退本面板的访问记录；
      实时部分来自 <code>pi://event</code>。等内核具备 browser session 能力后再换成内嵌页面。
    </p>
  </section>
</template>

<style src="./AgentBrowserPane.css" scoped></style>
