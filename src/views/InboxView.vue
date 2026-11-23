<script setup lang="ts">
import { t } from '@/i18n'
/**
 * 收件箱 + 定时任务。
 *
 * 主动服务的产物容器：调度器跑完任务后把结论写进收件箱（Rust 端落盘），
 * 这里负责展示、标记已读、以及创建/暂停/立即执行定时任务。
 * 任务状态机在 Rust 侧，前端不重复计算「下次什么时候跑」。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { invoke } from '@tauri-apps/api/core'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import AppTextarea from '@/components/ui/AppTextarea.vue'
import AppCheckbox from '@/components/ui/AppCheckbox.vue'
import {
  useProactive,
  type GrantUsage,
  type InboxItem,
  type JobStatus,
  type ProactiveJob,
  type ProactiveSnapshot,
} from '@/composables/useProactive'
import type { Project } from '@/composables/useProject'
import { timeAgo } from '@/utils/timeAgo'
import { listOf } from '@/utils/ipc'

const route = useRoute()
const {
  snapshot,
  createJob,
  setEnabled,
  removeJob,
  runNow,
  setGrant,
  markRead,
  markAllRead,
} = useProactive()

const jobs = ref<ProactiveJob[]>([])
const inbox = ref<InboxItem[]>([])
const runningJob = ref<string | null>(null)
const grantUsage = ref<GrantUsage | null>(null)
const loadError = ref('')
const notice = ref('')
const busy = ref('')
const loading = ref(true)
let noticeTimer = 0

/** 可读反馈：保存成功、或把后端错误翻成用户能懂的一句话。 */
function say(text: string) {
  notice.value = text
  window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => (notice.value = ''), 4000)
}

function friendly(e: unknown) {
  const raw =
    typeof e === 'string' ? e : ((e as { message?: string } | null)?.message ?? String(e))
  if (/执行中/.test(raw)) return t('任务正在执行，预授权暂不可修改。等本次跑完再保存。') // i18n-ignore: backend message pattern
  if (/额度/.test(raw)) return raw // i18n-ignore: backend message pattern
  // 运行时异常（TypeError/ReferenceError…）直接给一句人话，绝不把英文堆栈摆到页面上。
  if (/(TypeError|ReferenceError|SyntaxError|Cannot read|is not a function)/.test(raw))
    return t('加载失败，请稍后重试')
  if (!raw.trim()) return t('保存失败，请稍后重试')
  return raw
}

const STATUS_LABEL = computed<Record<JobStatus, string>>(() => ({
  pending: t('等待执行'),
  running: t('执行中'),
  failed: t('失败'),
  done: t('已完成'),
  interrupted: t('已中断'),
}))

const INTERVALS = computed(() => [
  { value: '1800', label: t('每 30 分钟') },
  { value: '3600', label: t('每小时') },
  { value: '21600', label: t('每 6 小时') },
  { value: '86400', label: t('每天') },
])

const CAP_OPTIONS = computed(() =>
  [20, 40, 80, 200].map((n) => ({ value: String(n), label: t('{0} 次', [n]) })),
)

function apply(s: ProactiveSnapshot) {
  jobs.value = s.jobs
  inbox.value = s.inbox
  runningJob.value = s.running_job
  grantUsage.value = s.grant_usage ?? null
}

async function refresh() {
  try {
    apply(await snapshot())
    loadError.value = ''
  } catch (e) {
    loadError.value = friendly(e)
  } finally {
    loading.value = false
  }
}

async function act(key: string, fn: () => Promise<ProactiveSnapshot>) {
  busy.value = key
  try {
    apply(await fn())
    loadError.value = ''
  } catch (e) {
    loadError.value = friendly(e)
  } finally {
    busy.value = ''
  }
}

/* ── 新建任务 ─────────────────────────────────────────────── */
const projects = ref<Project[]>([])
const createOpen = ref(false)
const draftTitle = ref('')
const draftPrompt = ref('')
const draftProject = ref('')
const draftInterval = ref('3600')
/** 建任务时就告诉用户有预授权可设：勾选后创建完直接打开额度弹窗。 */
const draftGrantAfterCreate = ref(true)
const createError = ref('')

const projectOptions = computed(() =>
  projects.value
    .filter((p) => p.path)
    .map((p) => ({ value: p.id, label: p.name, hint: p.path ?? '' })),
)

async function loadProjects() {
  projects.value = await listOf(invoke<Project[]>('projects_list'))
  if (!draftProject.value) draftProject.value = projectOptions.value[0]?.value ?? ''
}

function openCreate() {
  createError.value = ''
  draftTitle.value = ''
  draftPrompt.value = ''
  draftInterval.value = '3600'
  draftGrantAfterCreate.value = true
  createOpen.value = true
  void loadProjects()
}

async function submitCreate() {
  const project = projects.value.find((p) => p.id === draftProject.value)
  if (!draftTitle.value.trim() || !draftPrompt.value.trim() || !project?.path) {
    createError.value = t('标题、任务内容、项目目录都必填')
    return
  }
  busy.value = 'create'
  const before = new Set(jobs.value.map((j) => j.id))
  try {
    apply(
      await createJob({
        title: draftTitle.value.trim(),
        prompt: draftPrompt.value.trim(),
        cwd: project.path,
        interval_secs: Number(draftInterval.value),
      }),
    )
    createOpen.value = false
    if (draftGrantAfterCreate.value) {
      const created = jobs.value.find((j) => !before.has(j.id))
      if (created) openGrant(created)
    } else {
      say(t('任务已创建；任务卡上的「预授权」可随时调整额度。'))
    }
  } catch (e) {
    createError.value = friendly(e)
  } finally {
    busy.value = ''
  }
}

/* ── 删除确认 ─────────────────────────────────────────────── */
const removeOpen = ref(false)
let removeTarget: ProactiveJob | null = null

function startRemove(job: ProactiveJob) {
  removeTarget = job
  removeOpen.value = true
}

async function submitRemove() {
  if (!removeTarget) return
  const id = removeTarget.id
  removeOpen.value = false
  await act(`remove-${id}`, () => removeJob(id))
}

/* ── 预授权编辑 ───────────────────────────────────────────── */
const grantOpen = ref(false)
const grantJob = ref<ProactiveJob | null>(null)
const grantBash = ref('')
const grantCap = ref('40')
const grantError = ref('')

function openGrant(job: ProactiveJob) {
  grantJob.value = job
  grantBash.value = job.grant.bash_allow.join('\n')
  grantCap.value = String(job.grant.max_tool_calls)
  grantError.value = ''
  grantOpen.value = true
}

/** 当前任务的风险动作额度用量（只在该任务有一次运行记录时展示）。 */
function usageFor(job: ProactiveJob): GrantUsage | null {
  const usage = grantUsage.value
  return usage && usage.job_id === job.id ? usage : null
}

const grantUsageNow = computed(() =>
  grantJob.value ? usageFor(grantJob.value) : null,
)

/** 保存前就地校验，比等后端报错更快，也给中文原因。 */
const grantCheck = computed(() => {
  const cap = Number(grantCap.value)
  if (!Number.isInteger(cap) || cap < 1 || cap > 200) return t('额度需要是 1 到 200 之间的整数')
  const lines = grantBash.value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const dup = lines.find((line, i) => lines.indexOf(line) !== i)
  if (dup) return t('前缀重复：{0}，删掉一条再保存', [dup])
  return ''
})

/** 用量条宽度按已用/上限归一，上限为 0 时按满格处理。 */
function usagePct(usage: GrantUsage | null) {
  if (!usage) return 0
  if (!usage.max) return 100
  return Math.min(100, Math.round((usage.used / usage.max) * 100))
}

function usageLeft(usage: GrantUsage | null) {
  if (!usage) return 0
  return Math.max(0, usage.max - usage.used)
}

async function submitGrant() {
  if (!grantJob.value) return
  if (grantCheck.value) {
    grantError.value = grantCheck.value
    return
  }
  const prefixes = grantBash.value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  busy.value = 'grant'
  grantError.value = ''
  try {
    apply(await setGrant(grantJob.value.id, prefixes, Number(grantCap.value)))
    grantOpen.value = false
    say(t('预授权已保存，从下一次运行起生效'))
  } catch (e) {
    grantError.value = friendly(e)
  } finally {
    busy.value = ''
  }
}

/* ── 收件箱 ───────────────────────────────────────────────── */
const unread = computed(() => inbox.value.filter((i) => !i.read).length)
const highlightJob = ref('')

async function openItem(item: InboxItem) {
  if (!item.read) {
    await act(`read-${item.id}`, () => markRead(item.id, true))
  }
  highlightJob.value = item.job_id
  const el = document.querySelector(`[data-job="${item.job_id}"]`)
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  window.setTimeout(() => {
    if (highlightJob.value === item.job_id) highlightJob.value = ''
  }, 2400)
}

function intervalLabel(secs: number) {
  return INTERVALS.value.find((i) => Number(i.value) === secs)?.label ?? t('每 {0} 分钟', [Math.round(secs / 60)])
}

/** 下次触发是未来时间，不能用「N 分钟前」，这里单独算正向差值。 */
function nextLabel(job: ProactiveJob) {
  if (!job.enabled) return t('已暂停')
  const diff = job.next_at - Date.now()
  if (diff <= 0) return t('即将执行')
  const min = Math.round(diff / 60_000)
  if (min < 1) return t('不到 1 分钟后')
  if (min < 60) return t('{0} 分钟后', [min])
  const h = Math.round(min / 60)
  if (h < 48) return t('{0} 小时后', [h])
  return t('{0} 天后', [Math.round(h / 24)])
}

function grantLabel(job: ProactiveJob) {
  const bash = job.grant.bash_allow.length
    ? t('bash 白名单 {0} 条', [job.grant.bash_allow.length])
    : t('bash 风险命令默认拒绝')
  return t('{0} · 写入限于项目目录 · 单次 ≤ {1} 次风险动作', [bash, job.grant.max_tool_calls])
}

/** 通知点击或被跳转过来时，定位到 `?job=` 指定的任务，并顺带把对应收件条目标已读。 */
function focusFromQuery() {
  const jobId = typeof route.query.job === 'string' ? route.query.job : ''
  const itemId = typeof route.query.item === 'string' ? route.query.item : ''
  if (itemId) {
    const item = inbox.value.find((i) => i.id === itemId)
    if (item && !item.read) {
      void markRead(itemId, true)
        .then(apply)
        .catch(() => {})
    }
  }
  if (!jobId) return
  highlightJob.value = jobId
  void nextTick(() => {
    document
      .querySelector(`[data-job="${jobId}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  })
  window.setTimeout(() => {
    if (highlightJob.value === jobId) highlightJob.value = ''
  }, 2400)
}

watch(
  () => route.query.job,
  () => focusFromQuery(),
)

onMounted(() => {
  void refresh().then(() => focusFromQuery())
  void loadProjects()
})
</script>

<template>
  <div class="inbox-view">
    <header class="ib-head">
      <div>
        <h1>{{ t('收件箱') }}</h1>
        <p>{{ t('定时任务产出的结论与失败告警都落在这里。') }}</p>
      </div>
      <div class="ib-head-actions">
        <AppButton variant="secondary" class="ib-btn" :disabled="!unread || busy !== ''" @click="act('read-all', markAllRead)">
          <AppIcon name="check" :size="14" />
          <span>{{ t('全部标记已读') }}</span>
        </AppButton>
        <AppButton variant="primary" class="ib-btn primary" @click="openCreate">
          <AppIcon name="plus" :size="14" />
          <span>{{ t('新建定时任务') }}</span>
        </AppButton>
      </div>
    </header>

    <p v-if="loadError" class="state-error" role="alert">{{ loadError }}</p>
    <p v-if="notice" class="ib-ok" role="status">{{ notice }}</p>

    <section class="ib-panel">
      <header class="ib-panel-head">
        <h2>{{ t('全部产物') }}</h2>
        <span v-if="inbox.length" class="ib-panel-count">
          {{ unread ? t('未读 {0} / 共 {1}', [unread, inbox.length]) : t('共 {0} 条', [inbox.length]) }}
        </span>
      </header>
      <ul v-if="loading" class="sk-list" role="status" :aria-label="t('正在加载收件箱…')">
        <li v-for="n in 3" :key="n" class="sk-row">
          <span class="skeleton sk-dot"></span>
          <div class="sk-lines">
            <span class="skeleton sk-line tall w-60"></span>
            <span class="skeleton sk-line sk-body w-80"></span>
          </div>
        </li>
      </ul>
      <ul v-else-if="inbox.length" class="ib-list">
        <li
          v-for="item in inbox"
          :key="item.id"
          class="ib-item"
          :class="{ unread: !item.read, failure: item.kind === 'failure' }"
          role="button"
          tabindex="0"
          @click="openItem(item)"
          @keydown.enter="openItem(item)"
          @keydown.space.prevent="openItem(item)"
        >
          <span class="ib-dot" aria-hidden="true"></span>
          <div class="ib-item-main">
            <div class="ib-item-top">
              <span class="ib-item-title" :title="item.title">{{ item.title }}</span>
              <span class="ib-item-time">{{ timeAgo(item.created_at) }}</span>
            </div>
            <p class="ib-item-body" :title="item.body">{{ item.body }}</p>
          </div>
        </li>
      </ul>
      <div v-else-if="!loading" class="empty-state is-compact">
        <span class="empty-icon"><AppIcon name="inbox" :size="16" /></span>
        <div class="empty-copy">
          <p class="empty-title">{{ t('还没有产物') }}</p>
          <p class="empty-hint">{{ t('新建定时任务，跑完自动归档到这里。') }}</p>
        </div>
      </div>
    </section>

    <section class="ib-panel">
      <header class="ib-panel-head">
        <h2>{{ t('定时任务') }}</h2>
        <span v-if="jobs.length" class="ib-panel-count">{{ t('{0} 个', [jobs.length]) }}</span>
      </header>
      <ul v-if="loading" class="sk-list" role="status" :aria-label="t('正在加载定时任务…')">
        <li v-for="n in 2" :key="n" class="sk-row">
          <div class="sk-lines">
            <span class="skeleton sk-line tall w-30"></span>
            <span class="skeleton sk-line w-60"></span>
          </div>
          <span class="skeleton sk-act"></span>
        </li>
      </ul>
      <ul v-else-if="jobs.length" class="ib-jobs">
        <li
          v-for="job in jobs"
          :key="job.id"
          class="ib-job"
          :class="{ highlight: highlightJob === job.id }"
          :data-job="job.id"
        >
          <div class="ib-job-main">
            <div class="ib-job-top">
              <span class="ib-job-title" :title="job.title">{{ job.title }}</span>
              <span class="ib-chip" :class="`st-${job.status}`">{{ STATUS_LABEL[job.status] }}</span>
              <span v-if="runningJob === job.id" class="ib-chip st-running">{{ t('执行中') }}</span>
              <span v-if="job.status === 'running'" class="ib-chip st-locked">{{ t('预授权已锁') }}</span>
            </div>
            <div class="ib-job-meta">
              <span>{{ intervalLabel(job.interval_secs) }}</span>
              <span>{{ nextLabel(job) }}</span>
              <span :title="job.cwd">{{ job.cwd }}</span>
            </div>
            <p class="ib-job-grant">{{ grantLabel(job) }}</p>
            <div v-if="usageFor(job)" class="ib-usage">
              <div class="ib-usage-text">
                <span>{{ t('额度已用 {0} / {1}，剩余 {2}', [usageFor(job)?.used, usageFor(job)?.max, usageLeft(usageFor(job))]) }}
                </span>
                <span v-if="usageLeft(usageFor(job)) === 0" class="ib-usage-full">{{ t('额度用尽，后续风险动作会被拒绝') }}</span>
              </div>
              <div class="ib-meter" role="img" :aria-label="t('额度已用 {0}%', [usagePct(usageFor(job))])">
                <div
                  class="ib-meter-fill"
                  :class="{ full: usagePct(usageFor(job)) >= 100 }"
                  :style="{ width: usagePct(usageFor(job)) + '%' }"
                ></div>
              </div>
            </div>
            <p v-if="job.last_error" class="ib-job-error">{{ job.last_error }}</p>
          </div>
          <div class="ib-job-actions">
            <AppButton
              variant="icon"
              class="ib-icon-btn"
              :title="t('立即执行')"
              :aria-label="t('立即执行任务')"
              :disabled="busy !== ''"
              @click="act(`run-${job.id}`, () => runNow(job.id))"
            >
              <AppIcon name="play" :size="14" />
            </AppButton>
            <AppButton
              variant="secondary"
              class="ib-grant-btn"
              :disabled="busy !== '' || job.status === 'running'"
              :title="job.status === 'running' ? t('执行中不可修改预授权') : grantLabel(job)"
              :aria-label="job.status === 'running' ? t('执行中不可修改预授权') : t('设置预授权')"
              @click="openGrant(job)"
            >
              <AppIcon name="lock" :size="13" />
              <span>{{ t('预授权') }}</span>
            </AppButton>
            <AppButton
              variant="icon"
              class="ib-icon-btn"
              :title="job.enabled ? t('暂停') : t('启用')"
              :aria-label="job.enabled ? t('暂停任务') : t('启用任务')"
              :disabled="busy !== ''"
              @click="act(`toggle-${job.id}`, () => setEnabled(job.id, !job.enabled))"
            >
              <AppIcon :name="job.enabled ? 'stop' : 'play'" :size="14" />
            </AppButton>
            <AppButton
              variant="icon"
              class="ib-icon-btn danger"
              :title="t('删除任务')"
              :aria-label="t('删除任务')"
              :disabled="busy !== ''"
              @click="startRemove(job)"
            >
              <AppIcon name="trash" :size="14" />
            </AppButton>
          </div>
        </li>
      </ul>
      <div v-else-if="!loading" class="empty-state is-compact">
        <span class="empty-icon"><AppIcon name="clock" :size="16" /></span>
        <div class="empty-copy">
          <p class="empty-title">{{ t('还没有定时任务') }}</p>
          <p class="empty-hint">{{ t('让 PI 按周期自己跑一轮，结果回到上方产物。') }}</p>
        </div>
      </div>
    </section>

    <AppModal :open="createOpen" :title="t('新建定时任务')" size="md" @close="createOpen = false">
      <div class="ib-form">
        <label class="ib-field">
          <span>{{ t('任务标题') }}</span>
          <AppInput v-model="draftTitle" :placeholder="t('例如：每日代码库简报')" />
        </label>
        <label class="ib-field">
          <span>{{ t('任务内容') }}</span>
          <AppTextarea v-model="draftPrompt" :rows="5" :placeholder="t('到点后自动发给 Agent 的指令')" />
        </label>
        <label class="ib-field">
          <span>{{ t('项目目录') }}</span>
          <AppSelect
            v-model="draftProject"
            :options="projectOptions"
            :placeholder="t('先创建一个绑定目录的项目')"
          />
        </label>
        <label class="ib-field">
          <span>{{ t('执行周期') }}</span>
          <AppSelect v-model="draftInterval" :options="INTERVALS" />
        </label>
        <div class="ib-grant-hint">
          <AppCheckbox v-model="draftGrantAfterCreate" :label="t('创建后立即设置预授权')" />
          <p class="ib-note">{{ t('预授权决定无人值守时能跑哪些命令、最多几次风险动作。不设也能创建，之后在任务卡上点「预授权」调整。') }}</p>
        </div>
        <p class="ib-note">{{ t('无人值守只放行项目目录内的读写；风险命令默认全部拒绝，越界会记入审计日志。') }}</p>
        <p v-if="createError" class="state-error" role="alert">{{ createError }}</p>
      </div>
      <template #footer>
        <AppButton variant="secondary" class="ib-btn" @click="createOpen = false">{{ t('取消') }}</AppButton>
        <AppButton variant="primary" class="ib-btn primary" :disabled="busy === 'create'" @click="submitCreate">{{ t('创建') }}</AppButton>
      </template>
    </AppModal>

    <AppModal :open="grantOpen" :title="t('预授权')" size="md" @close="grantOpen = false">
      <div class="ib-form">
        <p class="ib-note">{{ t('任务「{0}」。改动只对下一次运行生效；任务执行中不可修改，避免中途提权。', [grantJob?.title]) }}</p>
        <label class="ib-field">
          <span>{{ t('允许的 bash 命令前缀（每行一条，留空 = 风险命令全部拒绝）') }}</span>
          <AppTextarea v-model="grantBash" :rows="4" placeholder="git status" />
        </label>
        <label class="ib-field">
          <span>{{ t('单次运行风险动作额度') }}</span>
          <AppSelect v-model="grantCap" :options="CAP_OPTIONS" />
        </label>
        <div class="ib-grant-root">
          <span>{{ t('写入根（固定为项目目录）') }}</span>
          <code>{{ grantJob?.grant.write_roots.join('、') || t('无') }}</code>
        </div>
        <p class="ib-note">{{ t('越界命令和越界写入会直接 block 并记入审计日志；授权文件 15 分钟过期，任务结束即清除。') }}</p>
        <div v-if="grantUsageNow" class="ib-usage">
          <div class="ib-usage-text">
            <span>{{ t('上次运行已用 {0} / {1}，剩余 {2}', [grantUsageNow.used, grantUsageNow.max, usageLeft(grantUsageNow)]) }}
            </span>
            <span v-if="usageLeft(grantUsageNow) === 0" class="ib-usage-full">{{ t('额度已用尽，下次运行的风险动作会被拒绝') }}</span>
          </div>
          <div class="ib-meter" role="img" :aria-label="t('额度已用 {0}%', [usagePct(grantUsageNow)])">
            <div
              class="ib-meter-fill"
              :class="{ full: usagePct(grantUsageNow) >= 100 }"
              :style="{ width: usagePct(grantUsageNow) + '%' }"
            ></div>
          </div>
        </div>
        <p v-else class="ib-note ib-usage-empty">{{ t('这个任务还没有运行记录，跑完第一次后这里会显示额度用量与剩余次数。') }}</p>
        <p v-if="grantCheck" class="ib-hint">{{ grantCheck }}</p>
        <p v-if="grantError" class="state-error" role="alert">{{ grantError }}</p>
      </div>
      <template #footer>
        <AppButton variant="secondary" class="ib-btn" @click="grantOpen = false">{{ t('取消') }}</AppButton>
        <AppButton
          variant="primary"
          class="ib-btn primary"
          :disabled="busy === 'grant' || !!grantCheck"
          @click="submitGrant"
        >
          {{ busy === 'grant' ? t('保存中…') : t('保存') }}
        </AppButton>
      </template>
    </AppModal>

    <AppModal :open="removeOpen" :title="t('删除定时任务')" size="sm" @close="removeOpen = false">
      <p class="ib-note">{{ t('将删除「{0}」及其调度记录。已进入收件箱的产物不会被删除。', [removeTarget?.title]) }}</p>
      <template #footer>
        <AppButton variant="secondary" class="ib-btn" @click="removeOpen = false">{{ t('取消') }}</AppButton>
        <AppButton variant="danger" class="ib-btn danger" @click="submitRemove">{{ t('删除') }}</AppButton>
      </template>
    </AppModal>
  </div>
</template>

<style src="./InboxView.css" scoped></style>
