<script setup lang="ts">
/**
 * 本地模型一级页：引擎探测 / 模型下载 / 启动接入。
 *
 * 数据全部来自 Rust `local_engine` 模块；页面只负责展示与动作编排，
 * 下载进度以事件 + 快照双通道恢复，切页不丢。
 */
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import { currentLocale, t } from '@/i18n'
import { listOf } from '@/utils/ipc'

interface ProbeReport {
  found: boolean
  usable: boolean
  path?: string
  version?: string
  reason?: string
  checked: number
  checked_at: number
}

interface EngineExit {
  at: number
  code?: number | null
  kind: string
  message: string
  model?: string
}

interface EngineStatus {
  running: boolean
  pid?: number
  port?: number
  model_file?: string
  model_name?: string
  base_url?: string
  started_at?: number
  last_exit?: EngineExit
}

interface PathsInfo {
  root: string
  models_dir: string
  logs_dir: string
  engine_log: string
}

interface InstalledModel {
  file: string
  name: string
  size_bytes: number
  modified_at: number
  quantization: string
  in_use: boolean
  active: boolean
}

interface CatalogModel {
  id: string
  name: string
  repo: string
  file: string
  params: string
  quantization: string
  size_bytes: number
  license: string
  tag: string
  /** 峰值内存估算（16k 上下文）与本机适配等级。 */
  required_bytes: number
  fit: 'comfortable' | 'tight' | 'no' | 'unknown'
}

interface HardwareInfo {
  total_memory_bytes: number
  unified_memory: boolean
  platform: string
}

interface DownloadSnapshot {
  id: string
  file: string
  name: string
  state: 'downloading' | 'cancelling' | 'cancelled' | 'completed' | 'failed'
  downloaded: number
  total: number
  speed_bps: number
  eta_secs?: number | null
  message?: string
  /** 任务启动时固定的下载源；改设置不会影响它。 */
  endpoint: string
}

interface DownloadSourceInfo {
  endpoint: string
  mode: 'mirror' | 'official' | 'custom'
  origin: 'settings' | 'env' | 'default'
  mirror: string
  official: string
  active_tasks: number
}

interface Activation {
  model_id: string
  model_name: string
  base_url: string
  needs_restart: boolean
}

const report = ref<ProbeReport | null>(null)
const status = ref<EngineStatus | null>(null)
const paths = ref<PathsInfo | null>(null)
const installed = ref<InstalledModel[]>([])
const catalog = ref<CatalogModel[]>([])
const downloads = ref<Record<string, DownloadSnapshot>>({})
const downloadSource = ref<DownloadSourceInfo | null>(null)
const hardware = ref<HardwareInfo | null>(null)
const probing = ref(false)
const loadingModels = ref(true)
const busy = ref<string | null>(null)
const error = ref('')
const rowError = ref<Record<string, string>>({})
const activation = ref<Activation | null>(null)
const restartNotice = ref('')
const restarting = ref(false)
// Pi 内核的系统提示与工具说明约 12k tokens，低于 16k 的窗口会在首次请求时超限。
const ctx = ref('16384')
const ctxOptions = [
  { value: '4096', label: '4096' },
  { value: '8192', label: '8192' },
  { value: '16384', label: '16384' },
  { value: '32768', label: '32768' },
]

const unlisteners: UnlistenFn[] = []

const engineLabel = computed(() => {
  if (status.value?.running) return t('已运行')
  if (probing.value || !report.value) return t('检测中…')
  if (report.value.usable) return t('可接管')
  if (report.value.found) return t('已安装，但无法启动')
  return t('未检测到')
})

const engineTone = computed(() => {
  if (status.value?.running) return 'is-live'
  if (probing.value || !report.value) return 'is-checking'
  if (report.value.usable) return 'is-ok'
  if (report.value.found) return 'is-err'
  return 'is-warn'
})

const installedFiles = computed(() => new Set(installed.value.map((m) => m.file)))

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

const sourceLabel = computed(() => {
  const s = downloadSource.value
  if (!s) return '—'
  const name =
    s.mode === 'mirror' ? t('国内镜像') : s.mode === 'official' ? t('直连官方') : t('自定义')
  return `${hostOf(s.endpoint)}（${name}）`
})

/** 有任务仍在用旧源：明确提示，不让用户误以为换源已对在途任务生效。 */
const staleSource = computed(() => {
  const current = downloadSource.value?.endpoint
  if (!current) return false
  return Object.values(downloads.value).some(
    (task) =>
      (task.state === 'downloading' || task.state === 'cancelling') && task.endpoint !== current,
  )
})

function toText(e: unknown): string {
  if (typeof e === 'string') return e
  if (e instanceof Error) return e.message
  return String(e)
}

function formatSize(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024)
  if (gb >= 1) return `${gb.toFixed(2)} GB`
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

function formatMemory(bytes: number): string {
  if (!bytes) return '—'
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

function fitLabel(fit: CatalogModel['fit']): string {
  if (fit === 'comfortable') return t('可流畅')
  if (fit === 'tight') return t('勉强够用')
  if (fit === 'no') return t('内存不足')
  return t('未知')
}

function fitTone(fit: CatalogModel['fit']): string {
  if (fit === 'comfortable') return 'is-live'
  if (fit === 'tight') return 'is-warn'
  if (fit === 'no') return 'is-err'
  return ''
}

function formatSpeed(bps: number): string {
  if (!bps) return '—'
  const mb = bps / (1024 * 1024)
  return mb >= 1 ? `${mb.toFixed(1)} MB/s` : `${Math.round(bps / 1024)} KB/s`
}

function formatTime(ms?: number | null): string {
  if (!ms) return '—'
  return new Intl.DateTimeFormat(currentLocale(), {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms))
}

function mmss(secs?: number | null): string {
  if (secs == null) return '—'
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

function tagLabel(tag: string): string {
  return t(tag === 'light' ? '轻量' : tag === 'code' ? '代码' : '对话')
}

function isInstalled(model: CatalogModel): boolean {
  return installedFiles.value.has(model.file)
}

function percentOf(task: DownloadSnapshot): number {
  if (!task.total) return 0
  return Math.min(100, Math.floor((task.downloaded / task.total) * 100))
}

const catalogRows = computed(() =>
  catalog.value.map((model) => {
    const raw = downloads.value[model.id]
    const task = raw && raw.state !== 'completed' ? raw : null
    return {
      model,
      task,
      percent: task ? percentOf(task) : 0,
      downloaded: task ? formatSize(task.downloaded) : '',
      total: task ? formatSize(task.total) : '',
      speed: task ? formatSpeed(task.speed_bps) : '',
      eta: task ? mmss(task.eta_secs) : '',
      installed: isInstalled(model),
    }
  }),
)

async function refreshProbe() {
  probing.value = true
  try {
    report.value = await invoke<ProbeReport>('local_engine_probe')
  } catch (e) {
    error.value = t('读取失败：{message}', { message: toText(e) })
  } finally {
    probing.value = false
  }
}

async function refreshStatus() {
  status.value = await invoke<EngineStatus>('local_engine_status').catch(() => null)
}

async function refreshPaths() {
  paths.value = await invoke<PathsInfo>('local_models_paths').catch(() => null)
}

async function refreshModels() {
  loadingModels.value = true
  try {
    installed.value = await listOf(invoke<InstalledModel[]>('local_models_list'))
  } catch (e) {
    error.value = t('读取失败：{message}', { message: toText(e) })
  } finally {
    loadingModels.value = false
  }
}

async function refreshCatalog() {
  catalog.value = await listOf(invoke<CatalogModel[]>('local_models_catalog'))
}

async function refreshHardware() {
  hardware.value = await invoke<HardwareInfo>('local_hardware_info').catch(() => null)
}

async function refreshDownloadSource() {
  downloadSource.value = await invoke<DownloadSourceInfo>('local_download_source').catch(
    () => null,
  )
}

async function refreshDownloads() {
  const tasks = await listOf(invoke<DownloadSnapshot[]>('local_downloads'))
  const next: Record<string, DownloadSnapshot> = {}
  for (const task of tasks) next[task.id] = task
  downloads.value = next
}

async function openModelsDir() {
  if (!paths.value) return
  await invoke('reveal_path', { path: paths.value.models_dir }).catch((e) => {
    error.value = t('操作失败：{message}', { message: toText(e) })
  })
}

async function startModel(file: string) {
  busy.value = file
  error.value = ''
  try {
    await invoke<EngineStatus>('local_engine_start', { file, ctx: Number(ctx.value) })
    await refreshStatus()
    await refreshModels()
  } catch (e) {
    error.value = t('启动失败：{message}', { message: toText(e) })
  } finally {
    busy.value = null
  }
}

async function stopEngine() {
  busy.value = 'stop'
  try {
    await invoke<EngineStatus>('local_engine_stop')
    await refreshStatus()
    await refreshModels()
  } catch (e) {
    error.value = t('启动失败：{message}', { message: toText(e) })
  } finally {
    busy.value = null
  }
}

async function connect(file: string) {
  busy.value = file
  error.value = ''
  try {
    activation.value = await invoke<Activation>('local_model_activate', { file })
    restartNotice.value = ''
    await refreshModels()
  } catch (e) {
    error.value = t('操作失败：{message}', { message: toText(e) })
  } finally {
    busy.value = null
  }
}

async function startAndConnect(file: string) {
  busy.value = file
  error.value = ''
  try {
    await invoke<EngineStatus>('local_engine_start', { file, ctx: Number(ctx.value) })
    await refreshStatus()
    activation.value = await invoke<Activation>('local_model_activate', { file })
    restartNotice.value = ''
    await refreshModels()
  } catch (e) {
    error.value = t('启动失败：{message}', { message: toText(e) })
  } finally {
    busy.value = null
  }
}

async function restartKernel() {
  restarting.value = true
  error.value = ''
  try {
    const ok = await invoke<boolean>('pi_restart')
    activation.value = null
    // 内核没在跑时 pi_restart 返回 false：这不是失败，配置已经写盘，
    // 下一次发送会按新模型拉起内核。按错误弹红字只会让人以为接入坏了。
    restartNotice.value = ok
      ? t('内核已重启，本地模型已生效。')
      : t('内核当前未运行，配置已写入；下次发送会自动用新模型启动。')
  } catch (e) {
    error.value = t('重启失败：{message}', { message: toText(e) })
  } finally {
    restarting.value = false
  }
}

async function download(id: string) {
  rowError.value = { ...rowError.value, [id]: '' }
  try {
    const snap = await invoke<DownloadSnapshot>('local_model_download', { id })
    downloads.value = { ...downloads.value, [id]: snap }
  } catch (e) {
    rowError.value = { ...rowError.value, [id]: toText(e) }
  }
}

async function cancel(id: string) {
  try {
    await invoke('local_model_cancel', { id })
    await refreshDownloads()
  } catch (e) {
    rowError.value = { ...rowError.value, [id]: toText(e) }
  }
}

async function removeFile(file: string, name: string) {
  if (!window.confirm(t('确定删除 {name}？该操作不可恢复。', { name }))) return
  try {
    await invoke('local_model_delete', { file })
    await refreshModels()
  } catch (e) {
    error.value = t('删除失败：{message}', { message: toText(e) })
  }
}

onMounted(async () => {
  unlisteners.push(
    await listen<DownloadSnapshot>('local-model://download', ({ payload }) => {
      downloads.value = { ...downloads.value, [payload.id]: payload }
      if (payload.state === 'completed') refreshModels()
    }),
  )
  unlisteners.push(
    await listen('local-engine://status', () => {
      refreshStatus()
      refreshModels()
    }),
  )
  await Promise.all([
    refreshProbe(),
    refreshStatus(),
    refreshPaths(),
    refreshModels(),
    refreshCatalog(),
    refreshDownloads(),
    refreshDownloadSource(),
    refreshHardware(),
  ])
})

onBeforeUnmount(() => {
  unlisteners.forEach((off) => off())
})
</script>

<template>
  <div class="page-shell">
    <div class="page-inner">
      <header class="page-head">
        <div>
          <h1 class="page-title">{{ t('本地模型') }}</h1>
          <p class="page-sub">
            {{ t('接管本机已有的 llama.cpp 引擎，不随应用打包；模型与日志统一放在应用数据目录。') }}
          </p>
        </div>
        <div class="page-actions">
          <AppButton variant="secondary" :disabled="probing" @click="refreshProbe">
            <AppIcon name="refresh" />
            {{ t('重新探测') }}
          </AppButton>
          <AppButton variant="secondary" @click="openModelsDir">
            <AppIcon name="folder" />
            {{ t('打开模型目录') }}
          </AppButton>
        </div>
      </header>

      <p v-if="error" class="state-error">{{ error }}</p>

      <div class="lm-top">
        <section class="card lm-engine">
          <div class="lm-card-head">
            <span class="lm-dot" :class="engineTone" />
            <h2 class="lm-card-title">{{ t('推理引擎') }}</h2>
            <span class="lm-state" :class="engineTone">{{ engineLabel }}</span>
          </div>

          <dl class="lm-facts">
            <div class="lm-fact">
              <dt>{{ t('引擎路径') }}</dt>
              <dd class="lm-mono">{{ report?.path || '—' }}</dd>
            </div>
            <div class="lm-fact">
              <dt>{{ t('版本') }}</dt>
              <dd class="lm-mono">{{ report?.version || '—' }}</dd>
            </div>
            <div v-if="report" class="lm-fact">
              <dt>{{ t('检查了 {n} 个候选位置', { n: report.checked }) }}</dt>
              <dd />
            </div>
            <div class="lm-fact">
              <dt>{{ t('运行状态') }}</dt>
              <dd v-if="status?.running" class="lm-live">
                {{ t('正在使用 {name}', { name: status.model_name }) }}
                · {{ t('启动于 {time}', { time: formatTime(status.started_at) }) }}
                · {{ t('端口 {port}', { port: status.port }) }}
              </dd>
              <dd v-else>{{ t('未检测到') }}</dd>
            </div>
            <div v-if="status?.last_exit" class="lm-fact">
              <dt>{{ t('最近退出') }}</dt>
              <dd class="lm-wrap">
                {{ formatTime(status.last_exit.at) }} · {{ status.last_exit.message }}
              </dd>
            </div>
            <div v-else class="lm-fact">
              <dt>{{ t('最近退出') }}</dt>
              <dd>{{ t('尚未启动过') }}</dd>
            </div>
          </dl>

          <p v-if="report?.reason" class="lm-reason" :class="{ 'is-muted': !report?.found }">
            {{ report.reason }}
          </p>

          <div class="lm-actions">
            <AppSelect v-model="ctx" :options="ctxOptions" :width="'120px'" />
            <AppButton
              v-if="status?.running"
              variant="secondary"
              :disabled="busy === 'stop'"
              @click="stopEngine"
            >
              <AppIcon name="stop" />
              {{ busy === 'stop' ? t('停止中…') : t('停止引擎') }}
            </AppButton>
          </div>
          <p class="lm-hint">
            {{ t('上下文低于 12k 时 Pi 的系统提示会超限，首次请求会失败；建议保持 16k 或更高。') }}
          </p>
          <p class="lm-hint">
            {{ t('推荐先安装 llama.cpp：brew install llama.cpp；也可以把 llama-server 放进 PATH 或设置 PI_LLAMA_SERVER。') }}
          </p>
        </section>

        <section class="card lm-paths">
          <h2 class="lm-card-title">{{ t('路径规则') }}</h2>
          <dl class="lm-facts">
            <div class="lm-fact is-column">
              <dt>{{ t('模型目录') }}</dt>
              <dd class="lm-mono">{{ paths?.models_dir || '—' }}</dd>
            </div>
            <div class="lm-fact is-column">
              <dt>{{ t('引擎日志') }}</dt>
              <dd class="lm-mono">{{ paths?.engine_log || '—' }}</dd>
            </div>
            <div class="lm-fact is-column">
              <dt>{{ t('应用数据目录') }}</dt>
              <dd class="lm-mono">{{ paths?.root || '—' }}</dd>
            </div>
          </dl>
          <p class="lm-hint">{{ t('首次使用前先安装 llama.cpp，或把已有 llama-server 加入 PATH。') }}</p>
        </section>
      </div>

      <div v-if="activation || restartNotice" class="lm-notice" role="status">
        <AppIcon name="info" />
        <div class="lm-notice-copy">
          <p class="lm-notice-title">
            {{ activation ? t('已接入「{name}」。', { name: activation.model_name }) : restartNotice }}
          </p>
          <p class="lm-notice-hint">
            {{ t('接入后会把本地端点写入模型配置，需要重启 Pi 内核才会生效。') }}
          </p>
        </div>
        <AppButton
          v-if="activation"
          variant="primary"
          size="sm"
          :disabled="restarting"
          @click="restartKernel"
        >
          {{ restarting ? t('重启中…') : t('立即重启内核') }}
        </AppButton>
      </div>

      <div class="section-head">
        <h2 class="section-title">{{ t('已安装模型') }}</h2>
        <span class="lm-count">{{ t('共 {n} 个', { n: installed.length }) }}</span>
      </div>

      <div v-if="loadingModels" class="lm-rows">
        <div v-for="i in 2" :key="i" class="card lm-row">
          <div class="skeleton sk-line w-40" />
        </div>
      </div>
      <div v-else-if="!installed.length" class="empty-state">
        <span class="empty-icon"><AppIcon name="database" /></span>
        <p class="empty-title">{{ t('暂无已安装模型，从下方精选目录下载一个开始。') }}</p>
      </div>
      <ul v-else class="lm-rows">
        <li v-for="m in installed" :key="m.file" class="card lm-row">
          <div class="lm-row-main">
            <div class="lm-row-title">
              <span class="lm-name">{{ m.name }}</span>
              <span v-if="m.active" class="lm-badge">{{ t('默认') }}</span>
              <span v-if="m.in_use" class="lm-badge is-live">{{ t('使用中') }}</span>
            </div>
            <div class="lm-row-meta">
              {{ m.quantization }} · {{ formatSize(m.size_bytes) }} · {{ formatTime(m.modified_at) }}
            </div>
          </div>
          <div class="lm-row-actions">
            <AppButton
              v-if="m.in_use && !m.active"
              variant="primary"
              size="sm"
              :disabled="!!busy"
              @click="connect(m.file)"
            >
              {{ busy === m.file ? t('接入中…') : t('接入内核') }}
            </AppButton>
            <AppButton
              v-else-if="!m.in_use"
              variant="primary"
              size="sm"
              :disabled="!!busy"
              @click="startAndConnect(m.file)"
            >
              {{ busy === m.file ? t('启动中…') : t('启动并接入') }}
            </AppButton>
            <AppButton variant="text" size="sm" @click="removeFile(m.file, m.name)">
              {{ t('删除') }}
            </AppButton>
          </div>
        </li>
      </ul>

      <div class="section-head">
        <h2 class="section-title">{{ t('精选目录') }}</h2>
        <span class="lm-count">{{ t('只收录核对过的开源 GGUF，不接在线搜索。') }}</span>
        <span class="lm-count">{{ t('下载源：{source}', { source: sourceLabel }) }}</span>
      </div>
      <p class="lm-hint">
        {{
          t('适配判断按 16k 上下文与本机内存 {memory} 估算，未计入其他应用占用。', {
            memory: formatMemory(hardware?.total_memory_bytes || 0),
          })
        }}
        <template v-if="hardware?.unified_memory">
          {{ t('Mac 为统一内存，GPU 与系统共用同一池。') }}
        </template>
      </p>
      <p v-if="staleSource" class="lm-hint">
        {{ t('有任务仍在用启动时的下载源，切换只对之后的新任务生效。') }}
      </p>

      <ul class="lm-rows">
        <li v-for="row in catalogRows" :key="row.model.id" class="card lm-row">
          <div class="lm-row-main">
            <div class="lm-row-title">
              <span class="lm-name">{{ row.model.name }}</span>
              <span class="lm-badge">{{ tagLabel(row.model.tag) }}</span>
              <span class="lm-badge" :class="fitTone(row.model.fit)">
                {{ fitLabel(row.model.fit) }}
              </span>
            </div>
            <div class="lm-row-meta">
              {{ t('参数') }} {{ row.model.params }} · {{ row.model.quantization }} ·
              {{ formatSize(row.model.size_bytes) }} · {{ t('许可') }} {{ row.model.license }} ·
              {{ t('预计占用 {size}', { size: formatMemory(row.model.required_bytes) }) }}
            </div>

            <div v-if="row.task" class="lm-progress">
              <div class="lm-progress-head">
                <span>{{ t('下载进度') }}</span>
                <span>{{ row.percent }}%</span>
              </div>
              <div
                class="lm-bar"
                role="progressbar"
                :aria-valuenow="row.percent"
                aria-valuemin="0"
                aria-valuemax="100"
              >
                <span :style="{ width: `${row.percent}%` }" />
              </div>
              <div class="lm-progress-meta">
                <span>{{ t('已完成 {done} / {total}', { done: row.downloaded, total: row.total }) }}</span>
                <span>{{ row.speed }}</span>
                <span>{{ t('源 {host}', { host: hostOf(row.task.endpoint) }) }}</span>
                <span v-if="row.task.state === 'downloading'">
                  {{ t('剩余 {time}', { time: row.eta }) }}
                </span>
                <span v-else>{{ t('正在取消…') }}</span>
              </div>
              <p v-if="row.task.message" class="lm-progress-msg">{{ row.task.message }}</p>
            </div>

            <p v-if="rowError[row.model.id]" class="lm-row-error">{{ rowError[row.model.id] }}</p>
          </div>

          <div class="lm-row-actions">
            <template v-if="row.task">
              <AppButton
                v-if="row.task.state === 'downloading'"
                variant="secondary"
                size="sm"
                @click="cancel(row.model.id)"
              >
                {{ t('取消') }}
              </AppButton>
              <span v-else class="lm-done">{{ t('正在取消…') }}</span>
            </template>
            <span v-else-if="row.installed" class="lm-done">
              <AppIcon name="check" />
              {{ t('已下载') }}
            </span>
            <AppButton v-else variant="primary" size="sm" @click="download(row.model.id)">
              <AppIcon name="download" />
              {{ t('下载') }}
            </AppButton>
            <AppButton
              v-if="row.installed"
              variant="text"
              size="sm"
              @click="removeFile(row.model.file, row.model.name)"
            >
              {{ t('删除') }}
            </AppButton>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>

<style src="./LocalModelsView.css"></style>
