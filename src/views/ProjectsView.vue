<script setup lang="ts">
import { t } from '@/i18n'
/**
 * 项目主页 —— 卡片式项目列表与归档 / 绑定目录入口。
 *
 * 版式来源：本仓项目面板的既有版式规范
 * 与 styles.ts，仅把 React 实现换成 Vue。
 *
 * 与内核的接合点：
 *  - 品牌与内核保留 Pi，UI 版式 1:1。
 *  - 卡片右侧是「归档」，后端已补齐 project_archive / project_unarchive。
 *  - 卡片点击进入 /projects/:id 工作台（配置修订 / 计划项 / 资产 / 活动）。
 *  - 新建弹窗提供原生「选择目录」，避免手写路径出错。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { invoke } from '@tauri-apps/api/core'
import { PICK_TIMEOUT_NOTE, pickDirectoryGuarded } from '@/composables/useDirPicker'
import {
  describeProjectError,
  type Project,
  type ProjectSnapshot,
  type ProjectTemplate as Template,
} from '@/composables/useProject'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import AppTextarea from '@/components/ui/AppTextarea.vue'

const router = useRouter()

const projects = ref<Project[]>([])
/** 模板清单以后端 projects_templates 为唯一来源，前端不再复制一份 id 表。 */
const templates = ref<Template[]>([])
const activeId = ref<string | null>(null)
const keyword = ref('')
const status = ref<'active' | 'archived'>('active')

const creating = ref(false)
const draftName = ref('')
const draftPath = ref('')
const draftInstruction = ref('')
const draftTemplate = ref('')
const pickingDir = ref(false)
const dirError = ref('')
const loadError = ref('')
const createError = ref('')
const loading = ref(true)

const visible = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  return projects.value
    .filter((p) => (status.value === 'active' ? !p.archived : p.archived))
    .filter(
      (p) => !k || p.name?.toLowerCase().includes(k) || (p.path ?? '').toLowerCase().includes(k),
    )
})

async function refresh() {
  loading.value = true
  loadError.value = ''
  try {
    projects.value = await invoke<Project[]>('projects_list')
  } catch (e) {
    projects.value = []
    loadError.value = t('读取项目列表失败: {0}', [e])
  }
  try {
    activeId.value = (await invoke<string | null>('project_active')) ?? null
  } catch {
    activeId.value = null
  }
  try {
    templates.value = await invoke<Template[]>('projects_templates')
  } catch {
    templates.value = []
  }
  loading.value = false
}

function openCreate(template?: Template) {
  draftName.value = template?.name ?? ''
  draftInstruction.value = template?.instruction ?? ''
  draftTemplate.value = template?.id ?? ''
  draftPath.value = ''
  createError.value = ''
  creating.value = true
}

function applyTemplate(id: string) {
  const hit = templates.value.find((t) => t.id === id)
  if (!hit) return
  draftTemplate.value = hit.id
  draftName.value = hit.name
  draftInstruction.value = hit.instruction
}

/** 用原生目录选择器代替手输路径；用户取消时保持原值不动。 */
async function chooseDirectory() {
  dirError.value = ''
  pickingDir.value = true
  // AUDIT-015①：裸 pickDirectory() 在系统选择器被吞时会把界面永久停在
  // 「正在选择…」；改用带 120s 超时 + 代际丢弃的 Guarded 版本。
  const { dir, timedOut } = await pickDirectoryGuarded()
  pickingDir.value = false
  if (timedOut) {
    dirError.value = PICK_TIMEOUT_NOTE()
    return
  }
  if (dir) draftPath.value = dir
}

function clearDirectory() {
  draftPath.value = ''
  dirError.value = ''
}

async function create() {
  const name = draftName.value.trim()
  if (!name) return
  createError.value = ''
  try {
    const snap = await invoke<ProjectSnapshot>('project_add', {
      name,
      description: '',
      templateId: draftTemplate.value || null,
      path: draftPath.value.trim() || null,
    })
    // 后端建项目时指令取自模板；用户在弹窗里改过就补一次配置修订，避免输入被丢掉。
    const instruction = draftInstruction.value.trim()
    const cfg = snap.config
    if (instruction && cfg && instruction !== cfg.instruction) {
      await invoke('project_update_config', {
        id: snap.project.id,
        instruction,
        capabilities: cfg.capabilities ?? [],
        expectedRevisionId: cfg.id,
        expectedRevisionNumber: cfg.number,
      }).catch(() => {})
    }
    await invoke('project_set_active', { id: snap.project.id }).catch(() => {})
    activeId.value = snap.project.id
    creating.value = false
    await refresh()
  } catch (e) {
    createError.value = describeProjectError(e, t('创建项目失败：{0}', [String(e)]))
  }
}

async function openWorkspace(id: string) {
  activeId.value = id
  router.push(`/projects/${id}`)
}

async function archive(id: string) {
  try {
    projects.value = await invoke<Project[]>('project_archive', { id })
  } catch {
    /* 忽略 */
  }
}

async function unarchive(id: string) {
  try {
    projects.value = await invoke<Project[]>('project_unarchive', { id })
  } catch {
    /* 忽略 */
  }
}

function stamp(ts?: number) {
  if (!ts) return ''
  const diff = Date.now() - ts
  const min = 60_000
  const hour = 60 * min
  const day = 24 * hour
  if (diff < min) return t('刚刚')
  if (diff < hour) return t('{0} 分钟前', [Math.floor(diff / min)])
  if (diff < day) return t('{0} 小时前', [Math.floor(diff / hour)])
  return new Date(ts).toLocaleDateString()
}

onMounted(refresh)
</script>

<template>
  <section class="wd-projects">
    <div class="wd-p-center">
      <p v-if="loadError" class="wd-p-load-error">{{ loadError }}</p>
      <div class="wd-p-hero">
        <div class="wd-p-hero-copy">
          <h1>{{ t('项目') }}</h1>
          <p>{{ t('让资料、技能与 AI 任务，在项目中有序协作。') }}</p>
          <AppButton variant="primary" class="wd-p-create" @click="openCreate()">
            <AppIcon name="plus" :size="14" />
            <span>{{ t('新建项目') }}</span>
          </AppButton>
        </div>
        <div class="wd-p-hero-art" aria-hidden="true">
          <span class="wd-p-art-node"><AppIcon name="file" :size="26" /></span>
          <i />
          <span class="wd-p-art-hub"><AppIcon name="share-network" :size="34" /></span>
          <i />
          <span class="wd-p-art-node"><AppIcon name="list" :size="26" /></span>
        </div>
      </div>

      <div class="wd-p-section-head">
        <h2>{{ status === 'active' ? t('我的项目') : t('已归档项目') }}</h2>
        <div class="wd-p-center-filters">
          <AppSelect
            v-model="status"
            :options="[
              { value: 'active', label: t('进行中') },
              { value: 'archived', label: t('已归档') },
            ]"
          />
          <AppInput v-model="keyword" :placeholder="t('搜索项目')" />
        </div>
      </div>

      <p v-if="loading && !visible.length" class="load-state">{{ t('正在加载项目…') }}</p>

      <div class="wd-p-grid">
        <article
          v-for="p in visible"
          :key="p.id"
          class="wd-p-card wd-p-project-card"
          :class="{ active: p.id === activeId }"
        >
          <AppButton
            variant="card"
            class="wd-p-card-open"
            :aria-current="p.id === activeId ? 'page' : undefined"
            @click="openWorkspace(p.id)"
          >
            <span class="wd-p-card-icon"><AppIcon name="folder" :size="21" /></span>
            <span>
              <strong>{{ p.name }}</strong>
              <small>
                {{ t('{0} · 更新于 {1}', [p.path || t('未绑定目录'), stamp(p.updated_at)]) }}
              </small>
            </span>
          </AppButton>
          <AppButton
            v-if="status === 'active'"
            variant="text"
            class="wd-p-card-menu"
            :title="t('归档')"
            @click="archive(p.id)"
          >{{ t('归档') }}</AppButton>
          <AppButton
            v-else
            variant="text"
            class="wd-p-card-menu"
            :title="t('恢复')"
            @click="unarchive(p.id)"
          >{{ t('恢复') }}</AppButton>
        </article>
      </div>

      <div v-if="!loading && !visible.length" class="wd-p-empty">
        {{ keyword ? t('没有匹配的项目') : projects.length ? t('没有已归档项目') : t('还没有项目') }}
      </div>

      <div class="wd-p-section-head">
        <h2>{{ t('从模板创建') }}</h2>
      </div>

      <div class="wd-p-grid">
        <AppButton v-for="t in templates" :key="t.id" variant="card" class="wd-p-card" @click="openCreate(t)">
          <span class="wd-p-card-icon"><AppIcon name="sparkles" :size="21" /></span>
          <span>
            <strong>{{ t.name }}</strong>
            <small>{{ t.description }}</small>
          </span>
        </AppButton>
      </div>
    </div>

    <div v-if="creating" class="wd-p-modal-backdrop" @click.self="creating = false">
      <div class="wd-p-modal">
        <header>
          <h2>{{ t('新建项目') }}</h2>
          <AppButton variant="icon" :aria-label="t('关闭新建项目')" @click="creating = false"><AppIcon name="close" :size="15" /></AppButton>
        </header>
        <div class="wd-p-modal-body wd-p-create-body">
          <label class="wd-p-create-label">
            <b>{{ t('项目名称') }}</b>
            <AppInput v-model="draftName" :placeholder="t('请输入项目名称')" />
          </label>
          <div class="wd-p-create-instruction-head">
            <b>{{ t('模板') }}</b>
            <AppSelect
              :model-value="draftTemplate"
              :options="[
                { value: '', label: t('选择模板') },
                ...templates.map((t) => ({ value: t.id, label: t.name })),
              ]"
              @update:model-value="applyTemplate"
            />
          </div>
          <div class="wd-p-create-instruction">
            <AppTextarea
              v-model="draftInstruction"
              :rows="6"
              :placeholder="t('提供当前项目的背景信息和规范，让回答更精准；比如项目目标、团队习惯、风格偏好、输出约束等')"
            />
          </div>
          <label class="wd-p-create-label">
            <b>{{ t('目录（可选）') }}</b>
            <div class="wd-p-dir">
              <AppInput
                v-model="draftPath"
                :placeholder="t('留空则不绑定目录，之后可在工作台里选择')"
                mono
              />
              <AppButton
                variant="secondary"
                class="wd-p-dir-btn"
                :disabled="pickingDir"
                :title="pickingDir ? t('正在选择…') : t('打开系统目录选择器')"
                @click="chooseDirectory"
              >
                <AppIcon name="folder" :size="14" />
                <span>{{ pickingDir ? t('选择中…') : t('选择目录') }}</span>
              </AppButton>
              <AppButton v-if="draftPath" variant="icon" class="wd-p-dir-btn ghost" :title="t('清除')" :aria-label="t('清除目录')" @click="clearDirectory">
                <AppIcon name="close" :size="13" />
              </AppButton>
            </div>
            <small v-if="dirError" class="wd-p-dir-error">{{ dirError }}</small>
          </label>
          <p v-if="createError" class="wd-p-dir-error">{{ createError }}</p>
        </div>
        <footer>
          <span class="wd-p-muted">{{ t('切换模板会覆盖当前名称和指令') }}</span>
          <AppButton variant="secondary" class="wd-p-outline" @click="creating = false">{{ t('取消') }}</AppButton>
          <AppButton variant="primary" class="wd-p-primary" :disabled="!draftName.trim()" @click="create">{{ t('确定') }}</AppButton>
        </footer>
      </div>
    </div>
  </section>
</template>

<style src="./ProjectsView.css" scoped></style>
