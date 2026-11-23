<script setup lang="ts">
/**
 * 全局搜索面板（D-21）：⌘K / 侧栏搜索按钮唤起。
 * 数据与最近项在 useGlobalSearch，这里只管输入、键盘与进入。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { invoke } from '@tauri-apps/api/core'
import { t } from '@/i18n'
import AppModal from '@/components/ui/AppModal.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppButton from '@/components/ui/AppButton.vue'
import { isTauriRuntime } from '@/composables/useRuntime'
import {
  closePalette,
  openPalette,
  paletteOpen,
  prefetchPalette,
  recents,
  rememberHit,
  searchPalette,
  type HitKind,
  type PaletteHit,
} from '@/composables/useGlobalSearch'

const router = useRouter()
const inputEl = ref<HTMLInputElement | null>(null)
const query = ref('')
const hits = ref<PaletteHit[]>([])
const active = ref(0)
const loading = ref(false)
const error = ref(false)

let timer: ReturnType<typeof setTimeout> | undefined
/** 请求序号：只接受最后一次输入的结果，慢查询不会覆盖新查询。 */
let seq = 0

const ICONS: Record<HitKind, string> = {
  session: 'chat',
  project: 'folder',
  file: 'book',
  memory: 'database',
}
const KINDS: HitKind[] = ['session', 'project', 'file', 'memory']

function kindLabel(kind: HitKind): string {
  // 逐分支 t()：对象字面量塞 t() 会让覆盖率脚本看不见 key。
  switch (kind) {
    case 'session':
      return t('会话')
    case 'project':
      return t('项目')
    case 'file':
      return t('文件')
    case 'memory':
      return t('记忆')
  }
}

interface PaletteRow {
  header?: string
  hit?: PaletteHit
}

/** 有查询词时按类型插分组标题；最近项混排，不插标题。 */
const rows = computed<PaletteRow[]>(() => {
  const grouped = !!query.value.trim()
  const out: PaletteRow[] = []
  let last: HitKind | '' = ''
  for (const hit of hits.value) {
    if (grouped && hit.kind !== last) {
      out.push({ header: kindLabel(hit.kind) })
      last = hit.kind
    }
    out.push({ hit })
  }
  return out
})

watch(
  paletteOpen,
  async (open) => {
    if (!open) {
      if (timer) clearTimeout(timer)
      seq++
      return
    }
    query.value = ''
    hits.value = [...recents.value]
    active.value = 0
    error.value = false
    loading.value = false
    await prefetchPalette()
    if (!paletteOpen.value) return
    if (query.value.trim()) void runSearch(query.value)
    else hits.value = [...recents.value]
  },
  { immediate: true },
)

watch(query, (q) => {
  if (timer) clearTimeout(timer)
  if (!q.trim()) {
    seq++
    loading.value = false
    error.value = false
    hits.value = [...recents.value]
    active.value = 0
    return
  }
  hits.value = []
  active.value = 0
  loading.value = true
  timer = setTimeout(() => void runSearch(q), 150)
})

async function runSearch(q: string) {
  const mine = ++seq
  const out = await searchPalette(q)
  if (mine !== seq) return
  hits.value = out.hits
  error.value = out.error
  active.value = 0
  loading.value = false
}

function move(step: number) {
  if (!hits.value.length) return
  active.value = (active.value + step + hits.value.length) % hits.value.length
  void nextTick(() => {
    document.querySelector('.palette-row.active')?.scrollIntoView({ block: 'nearest' })
  })
}

function onInputKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    move(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    move(-1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    void openHit(hits.value[active.value])
  }
}

async function openHit(hit?: PaletteHit) {
  if (!hit) return
  rememberHit(hit)
  closePalette()
  if (hit.kind === 'session') {
    if (isTauriRuntime()) {
      await invoke('open_replay_window', { cwd: hit.cwd ?? '', index: Number(hit.index) }).catch(
        (e) => console.error('打开回放窗口失败', e), // i18n-ignore: developer log
      )
    } else {
      await router.push({ path: '/chat', query: { replay: String(hit.index), cwd: hit.cwd ?? '' } })
    }
    return
  }
  if (hit.kind === 'project') {
    await router.push(`/projects/${hit.projectId}`)
    return
  }
  if (hit.kind === 'file') {
    await router.push({ path: '/library', query: { view: 'search', q: hit.query ?? '' } })
    return
  }
  await router.push({ path: '/library', query: { view: 'memory' } })
}

/** 无结果时的出口：把当前词交给资料库搜索页，不自动跳、不清空输入。 */
async function openLibrarySearch() {
  const q = query.value.trim()
  if (!q) return
  rememberHit({ key: `query:${q}`, kind: 'file', title: q, meta: '', snippet: '', query: q })
  closePalette()
  await router.push({ path: '/library', query: { view: 'search', q } })
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
  )
}

function highlight(text: string): string {
  const q = query.value.trim()
  if (!q) return escapeHtml(text)
  const i = text.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0) return escapeHtml(text)
  return `${escapeHtml(text.slice(0, i))}<mark>${escapeHtml(text.slice(i, i + q.length))}</mark>${escapeHtml(text.slice(i + q.length))}`
}

/** ⌘K / Ctrl+K 开合。全仓无其他 ⌘K handler，Tauri 也没有菜单加速键占用。 */
function onGlobalKey(e: KeyboardEvent) {
  if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'k') return
  e.preventDefault()
  if (paletteOpen.value) closePalette()
  else openPalette()
}

onMounted(() => document.addEventListener('keydown', onGlobalKey))
onBeforeUnmount(() => document.removeEventListener('keydown', onGlobalKey))
</script>

<template>
  <AppModal
    :open="paletteOpen"
    :title="t('全局搜索')"
    size="lg"
    bare
    @close="closePalette"
  >
    <div class="palette">
      <div class="palette-input">
        <AppIcon name="search" :size="16" />
        <input
          ref="inputEl"
          v-model="query"
          class="palette-field"
          type="text"
          spellcheck="false"
          :placeholder="t('搜索会话、项目、文件与记忆')"
          :aria-label="t('全局搜索')"
          @keydown="onInputKeydown"
        />
        <kbd class="palette-kbd">Esc</kbd>
      </div>

      <div class="palette-body">
        <div v-if="error" class="palette-state err">{{ t('搜索服务不可用，请稍后再试') }}</div>
        <div v-else-if="loading && !hits.length" class="palette-state">{{ t('搜索中…') }}</div>
        <ul v-else-if="hits.length" class="palette-list">
          <template v-for="row in rows" :key="row.hit ? row.hit.key : `head-${row.header}`">
            <li v-if="row.header" class="palette-head">{{ row.header }}</li>
            <li
              v-else-if="row.hit"
              class="palette-row"
              :class="{ active: row.hit === hits[active] }"
              @mouseenter="active = hits.indexOf(row.hit)"
              @click="openHit(row.hit)"
            >
              <AppIcon :name="ICONS[row.hit.kind]" :size="15" class="palette-icon" />
              <div class="palette-text">
                <div class="palette-title" v-html="highlight(row.hit.title)"></div>
                <div v-if="row.hit.meta" class="palette-meta">{{ row.hit.meta }}</div>
                <div v-if="row.hit.snippet" class="palette-snippet">{{ row.hit.snippet }}</div>
              </div>
              <span class="palette-kind">{{ kindLabel(row.hit.kind) }}</span>
            </li>
          </template>
        </ul>
        <div v-else-if="query.trim()" class="palette-empty">
          <p>{{ t('没有找到「{0}」', [query.trim()]) }}</p>
          <AppButton variant="secondary" @click="openLibrarySearch">
            {{ t('在资料库中搜索') }}
          </AppButton>
        </div>
        <div v-else class="palette-empty">
          <p>{{ t('输入关键词，搜索会话、项目、文件与记忆') }}</p>
          <div class="palette-kinds">
            <span v-for="k in KINDS" :key="k">{{ kindLabel(k) }}</span>
          </div>
        </div>
      </div>

      <div class="palette-foot">
        <span>↑↓ {{ t('选择') }}</span>
        <span>↵ {{ t('打开') }}</span>
        <span>Esc {{ t('关闭') }}</span>
      </div>
    </div>
  </AppModal>
</template>

<style src="./CommandPalette.css" scoped></style>
