<script setup lang="ts">
/**
 * 项目主页 —— 卡片式项目列表与归档 / 绑定目录入口。
 *
 * 版式来源：packages/plugins/projects/src/client/ProjectsPanel.tsx
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
import { pickDirectory } from '@/composables/useDirPicker'
import {
  describeProjectError,
  type Project,
  type ProjectSnapshot,
  type ProjectTemplate as Template,
} from '@/composables/useProject'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppSelect from '@/components/ui/AppSelect.vue'
import AppTextarea from '@/components/ui/AppTextarea.vue'
import AppModal from '@/components/ui/AppModal.vue'

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

const visible = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  return projects.value
    .filter((p) => (status.value === 'active' ? !p.archived : p.archived))
    .filter(
      (p) => !k || p.name?.toLowerCase().includes(k) || (p.path ?? '').toLowerCase().includes(k),
    )
})

async function refresh() {
  loadError.value = ''
  try {
    projects.value = await invoke<Project[]>('projects_list')
  } catch (e) {
    projects.value = []
    loadError.value = `读取项目列表失败: ${e}`
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
  const dir = await pickDirectory()
  pickingDir.value = false
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
    createError.value = describeProjectError(e, `创建项目失败：${String(e)}`)
  }
}

async function open(id: string) {
  try {
    await invoke('project_set_active', { id })
  } catch {
    /* 忽略 */
  }
  activeId.value = id
  router.push('/chat')
}

function openWorkspace(id: string) {
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

/** 删除是不可逆操作（项目记录连同计划项/资产一起没了），必须二次确认。 */
const removingId = ref<string | null>(null)
const removeError = ref('')
const removingName = computed(
  () => projects.value.find((p) => p.id === removingId.value)?.name ?? '',
)

function askRemove(id: string) {
  removeError.value = ''
  removingId.value = id
}

async function doRemove() {
  const id = removingId.value
  if (!id) return
  try {
    projects.value = await invoke<Project[]>('project_remove', { id })
    if (activeId.value === id) activeId.value = null
    removingId.value = null
  } catch (e) {
    removeError.value = describeProjectError(e, `删除失败：${String(e)}`)
  }
}

function stamp(ts?: number) {
  if (!ts) return ''
  const diff = Date.now() - ts
  const min = 60_000
  const hour = 60 * min
  const day = 24 * hour
  if (diff < min) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
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
          <h1>项目</h1>
          <p>让资料、技能与 AI 任务，在项目中有序协作。</p>
          <button class="wd-p-create" @click="openCreate()">
            <AppIcon name="plus" :size="14" />
            <span>新建项目</span>
          </button>
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
        <h2>{{ status === 'active' ? '我的项目' : '已归档项目' }}</h2>
        <div class="wd-p-center-filters">
          <AppSelect
            v-model="status"
            :options="[
              { value: 'active', label: '进行中' },
              { value: 'archived', label: '已归档' },
            ]"
          />
          <AppInput v-model="keyword" placeholder="搜索项目" />
        </div>
      </div>

      <div class="wd-p-grid">
        <article
          v-for="p in visible"
          :key="p.id"
          class="wd-p-card wd-p-project-card"
          :class="{ active: p.id === activeId }"
        >
          <button class="wd-p-card-open" @click="openWorkspace(p.id)">
            <span class="wd-p-card-icon"><AppIcon name="folder" :size="21" /></span>
            <span>
              <strong>{{ p.name }}</strong>
              <small>
                {{ p.path || '未绑定目录' }} · 更新于 {{ stamp(p.updated_at) }}
              </small>
            </span>
          </button>
          <button
            v-if="status === 'active'"
            class="wd-p-card-archive"
            title="归档"
            @click="archive(p.id)"
          >
            归档
          </button>
          <button
            v-if="status === 'active'"
            class="wd-p-card-chat"
            title="在对话中打开"
            @click.stop="open(p.id)"
          >
            <AppIcon name="chat" :size="14" />
          </button>
          <button v-else class="wd-p-card-archive" title="恢复" @click="unarchive(p.id)">恢复</button>
          <button class="wd-p-card-del" title="删除项目" @click.stop="askRemove(p.id)">
            <AppIcon name="trash" :size="14" />
          </button>
        </article>
      </div>

      <div v-if="!visible.length" class="wd-p-empty">
        {{ keyword ? '没有匹配的项目' : projects.length ? '没有已归档项目' : '还没有项目' }}
      </div>

      <div class="wd-p-section-head">
        <h2>从模板创建</h2>
      </div>

      <div class="wd-p-grid">
        <button v-for="t in templates" :key="t.id" class="wd-p-card" @click="openCreate(t)">
          <span class="wd-p-card-icon"><AppIcon name="sparkles" :size="21" /></span>
          <span>
            <strong>{{ t.name }}</strong>
            <small>{{ t.description }}</small>
          </span>
        </button>
      </div>
    </div>

    <div v-if="creating" class="wd-p-modal-backdrop" @click.self="creating = false">
      <div class="wd-p-modal">
        <header>
          <h2>新建项目</h2>
          <button @click="creating = false"><AppIcon name="close" :size="15" /></button>
        </header>
        <div class="wd-p-modal-body wd-p-create-body">
          <label class="wd-p-create-label">
            <b>项目名称</b>
            <AppInput v-model="draftName" placeholder="请输入项目名称" />
          </label>
          <div class="wd-p-create-instruction-head">
            <b>模板</b>
            <AppSelect
              :model-value="draftTemplate"
              :options="[
                { value: '', label: '选择模板' },
                ...templates.map((t) => ({ value: t.id, label: t.name })),
              ]"
              @update:model-value="applyTemplate"
            />
          </div>
          <div class="wd-p-create-instruction">
            <AppTextarea
              v-model="draftInstruction"
              :rows="6"
              placeholder="提供当前项目的背景信息和规范，让回答更精准；比如项目目标、团队习惯、风格偏好、输出约束等"
            />
          </div>
          <label class="wd-p-create-label">
            <b>目录（可选）</b>
            <div class="wd-p-dir">
              <AppInput
                v-model="draftPath"
                placeholder="留空则不绑定目录，之后可在工作台里选择"
                mono
              />
              <button
                class="wd-p-dir-btn"
                :disabled="pickingDir"
                :title="pickingDir ? '正在选择…' : '打开系统目录选择器'"
                @click="chooseDirectory"
              >
                <AppIcon name="folder" :size="14" />
                <span>{{ pickingDir ? '选择中…' : '选择目录' }}</span>
              </button>
              <button v-if="draftPath" class="wd-p-dir-btn ghost" title="清除" @click="clearDirectory">
                <AppIcon name="close" :size="13" />
              </button>
            </div>
            <small v-if="dirError" class="wd-p-dir-error">{{ dirError }}</small>
          </label>
          <p v-if="createError" class="wd-p-dir-error">{{ createError }}</p>
        </div>
        <footer>
          <span class="wd-p-muted">切换模板会覆盖当前名称和指令</span>
          <button class="wd-p-outline" @click="creating = false">取消</button>
          <button class="wd-p-primary" :disabled="!draftName.trim()" @click="create">确定</button>
        </footer>
      </div>
    </div>

    <AppModal
      :open="removingId !== null"
      title="删除项目"
      size="sm"
      @close="removingId = null"
    >
      <p>删除「{{ removingName }}」会连同其计划项、资产与配置修订一起移除，无法恢复。</p>
      <p v-if="removeError" class="wd-p-dir-error">{{ removeError }}</p>
      <template #footer>
        <button class="wd-p-outline" @click="removingId = null">取消</button>
        <button class="wd-p-danger" @click="doRemove">确认删除</button>
      </template>
    </AppModal>
  </section>
</template>

<style src="./ProjectsView.css" scoped></style>
