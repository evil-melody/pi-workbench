<script setup lang="ts">
/**
 * 专家草稿编辑器 —— ExpertDefinition 表单。
 *
 * 四段式人格（角色定位 / 工作方法 / 行为边界 / 交付物）而不是一整段自由文本：
 * 写坏了能定位到具体字段，拼进 persona 时也知道是哪一段出了问题。
 *
 * 校验是「编辑器内实时 + 后端权威」双轨：
 *   本地只做即时提示（输入体验），是否可发布由 expert_validate 与 expert_publish 决定。
 * 保存走草稿修订号乐观锁，别人改过就报 revision-conflict 而不是静默覆盖。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppTextarea from '@/components/ui/AppTextarea.vue'
import AppModal from '@/components/ui/AppModal.vue'
import PublishConfirmDialog from './PublishConfirmDialog.vue'
import {
  describeExpertError,
  emptyDefinition,
  estimateTokens,
  expertConfirm,
  expertDraftLoad,
  expertDraftSave,
  expertPublish,
  expertRequestConfirmation,
  expertValidate,
  issuesFor,
  type ConfirmationRequest,
  type DomainIssue,
  type ExpertDefinition,
  type ExpertDraft,
  type ExpertPublication,
} from '@/composables/useExperts'

const props = defineProps<{
  expertId: string
  /** 项目根：填了才把 persona 写进项目级 .pi/roles/current.md，否则写用户级。 */
  projectRoot?: string | null
}>()

const emit = defineEmits<{
  saved: [draft: ExpertDraft]
  published: [pub: ExpertPublication]
  /** 名字被改掉，父级需要知道新 id 才能刷新列表。 */
  renamed: [id: string]
}>()

const loading = ref(false)
const saving = ref(false)
const publishing = ref(false)
const loadError = ref('')
const saveError = ref('')
const saveNotice = ref('')
const publishNotice = ref('')

const definition = ref<ExpertDefinition>(emptyDefinition())
/** 服务端权威草稿修订号：保存带上它做乐观锁。 */
const revision = ref(0)
const digest = ref('')
const digestDirty = ref(false)

const issues = ref<DomainIssue[]>([])
const validating = ref(false)
/** 本地即时校验与后端权威校验都过，按钮才亮。 */
const publishBusy = ref(false)

const newExpertId = ref('')
const showCreate = ref(false)
const createError = ref('')

const challenge = ref<ConfirmationRequest | null>(null)
const showConfirm = ref(false)

const PROSE_FIELDS = [
  { key: 'role', label: '角色定位', hint: '你是谁、擅长什么、以什么口吻说话。' },
  { key: 'methodology', label: '工作方法', hint: '按什么顺序推进任务、遇到不确定时怎么处理。' },
  { key: 'boundaries', label: '行为边界', hint: '绝对不能做的事，越界时必须明说。' },
  { key: 'deliverables', label: '交付物', hint: '最终以什么形式交付，格式与颗粒度要求。' },
] as const

const tagText = computed({
  get: () => definition.value.tags.join('、'),
  set: (raw: string) => {
    definition.value.tags = raw
      .split(/[,，、\s]+/)
      .map((t) => t.trim())
      .filter(Boolean)
  },
})

const personaText = computed(() => {
  const d = definition.value
  const parts = [`你是「${d.name}」。`, '', '## 角色定位', d.role.trim()]
  if (d.methodology.trim()) parts.push('', '## 工作方法', d.methodology.trim())
  if (d.boundaries.trim()) parts.push('', '## 行为边界', d.boundaries.trim())
  if (d.deliverables.trim()) parts.push('', '## 交付物', d.deliverables.trim())
  if (d.tags.length) parts.push('', '## 适用标签', d.tags.join('、'))
  return parts.join('\n')
})

const personaTokens = computed(() => estimateTokens(personaText.value))

const blocking = computed(() => issues.value.filter((i) => i.code !== 'definition/notice'))
const canPublish = computed(() => !loading.value && blocking.value.length === 0 && !publishBusy.value)

function fieldIssues(path: string) {
  return issuesFor(issues.value, path)
}

let validateSeq = 0
async function runValidate() {
  const seq = ++validateSeq
  validating.value = true
  try {
    const res = await expertValidate(definition.value)
    // 慢于本次输入的旧校验结果直接丢弃，避免「改了 A 却报 B 的错」。
    if (seq === validateSeq) issues.value = res
  } catch {
    if (seq === validateSeq) issues.value = []
  }
  validating.value = false
}

function markDirty() {
  digestDirty.value = true
}

let saveTimer: number | undefined
watch(
  definition,
  () => {
    markDirty()
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(runValidate, 260)
  },
  { deep: true },
)

onBeforeUnmount(() => window.clearTimeout(saveTimer))

async function load() {
  loading.value = true
  loadError.value = ''
  saveError.value = ''
  saveNotice.value = ''
  publishNotice.value = ''
  try {
    const draft = await expertDraftLoad(props.expertId)
    if (draft) {
      definition.value = draft.definition
      revision.value = draft.revision
      digest.value = draft.digest
    } else {
      definition.value = emptyDefinition()
      revision.value = 0
      digest.value = ''
    }
  } catch (e: unknown) {
    loadError.value = describeExpertError(e, '草稿读取失败')
  }
  digestDirty.value = false
  loading.value = false
  await runValidate()
}

watch(() => props.expertId, load, { immediate: true })

async function save() {
  saving.value = true
  saveError.value = ''
  saveNotice.value = ''
  publishNotice.value = ''
  try {
    const draft = await expertDraftSave(props.expertId, definition.value, revision.value)
    definition.value = draft.definition
    revision.value = draft.revision
    digest.value = draft.digest
    digestDirty.value = false
    saveNotice.value = `已保存为修订 #${draft.revision}`
    emit('saved', draft)
  } catch (e: unknown) {
    saveError.value = describeExpertError(e, '保存失败')
  }
  saving.value = false
}

async function requestChallenge() {
  if (!canPublish.value) return
  publishBusy.value = true
  saveError.value = ''
  try {
    // 先落盘再申请：challenge 绑定的是「已保存」的内容，否则发布的内容与确认的不是一个版本。
    if (digestDirty.value) await save()
    challenge.value = await expertRequestConfirmation(props.expertId, revision.value, digest.value)
    showConfirm.value = true
  } catch (e: unknown) {
    saveError.value = describeExpertError(e, '申请发布授权失败')
  }
  publishBusy.value = false
}

async function onConfirmed(token: string) {
  showConfirm.value = false
  publishing.value = true
  publishError.value = ''
  try {
    const proof = await expertConfirm(token)
    const pub = await expertPublish(props.expertId, proof, props.projectRoot ?? null)
    publishNotice.value = `已发布「${pub.name}」，persona 写入 ${pub.persona_path}`
    digestDirty.value = false
    emit('published', pub)
  } catch (e: unknown) {
    publishError.value = describeExpertError(e, '发布失败')
  }
  publishing.value = false
}

const publishError = ref('')

async function createDraft() {
  const id = newExpertId.value.trim()
  if (!id) return
  createError.value = ''
  try {
    // 新 id 尚无草稿，后端 revision 从 0 起算；definition 直接沿用当前表单内容。
    const draft = await expertDraftSave(id, definition.value, 0)
    definition.value = draft.definition
    revision.value = draft.revision
    digest.value = draft.digest
    digestDirty.value = false
    showCreate.value = false
    newExpertId.value = ''
    saveNotice.value = `已另存为新专家「${id}」，修订 #${draft.revision}`
    emit('saved', draft)
  } catch (e: unknown) {
    createError.value = describeExpertError(e, '另存失败')
  }
}

function addExample() {
  definition.value.examples.push({ id: `ex${definition.value.examples.length + 1}`, title: '', prompt: '' })
}

function addSkill() {
  definition.value.skill_requirements.push({ name: '' })
}

function removeExample(index: number) {
  definition.value.examples.splice(index, 1)
}

/** 可选字段走 model-value + 事件而不是 v-model：`v-model="x?.y"` 不是合法的赋值表达式，编译不过。 */
function setExampleTitle(index: number, value: string) {
  const ex = definition.value.examples[index]
  if (!ex) return
  ex.title = value.trim() || undefined
}

function removeSkill(index: number) {
  definition.value.skill_requirements.splice(index, 1)
}

defineExpose({ load })
</script>

<template>
  <section class="ed">
    <header class="ed-head">
      <div class="ed-head-main">
        <h3>专家草稿</h3>
        <span class="ed-meta">
          修订 #{{ revision || '—' }}
          <template v-if="digest">· 摘要 {{ digest.slice(0, 10) }}…</template>
          <template v-if="digestDirty">· 有未保存改动</template>
        </span>
      </div>
      <div class="ed-head-actions">
        <span v-if="loading" class="ed-state">读取中…</span>
        <button class="ed-btn" :disabled="saving || loading" @click="save">{{ saving ? '保存中…' : '保存草稿' }}</button>
        <button
          class="ed-btn primary"
          :disabled="!canPublish || publishing"
          :title="blocking.length ? '还有校验问题待解决' : '发布需要一次显式确认'"
          @click="requestChallenge"
        >
          {{ publishing ? '发布中…' : '发布' }}
        </button>
      </div>
    </header>

    <p v-if="loadError" class="ed-err">{{ loadError }}</p>
    <p v-if="saveError" class="ed-err">{{ saveError }}</p>
    <p v-if="publishError" class="ed-err">{{ publishError }}</p>
    <p v-if="saveNotice" class="ed-ok">{{ saveNotice }}</p>
    <p v-if="publishNotice" class="ed-ok">{{ publishNotice }}</p>

    <div class="ed-body">
      <div class="ed-col">
        <label class="ed-field">
          <span class="ed-label">专家 id<em>发布后作为唯一标识</em></span>
          <AppInput
            :model-value="expertId"
            readonly
            mono
            :placeholder="expertId"
          />
        </label>

        <label class="ed-field">
          <span class="ed-label">名称</span>
          <AppInput v-model="definition.name" placeholder="例如：代码评审专家" :maxlength="80" />
          <ul v-if="fieldIssues('name').length" class="ed-issues">
            <li v-for="(i, k) in fieldIssues('name')" :key="k">{{ i.message }}</li>
          </ul>
        </label>

        <label class="ed-field">
          <span class="ed-label">描述</span>
          <AppTextarea v-model="definition.description" :rows="2" placeholder="一句话说明这个专家解决什么问题" />
          <ul v-if="fieldIssues('description').length" class="ed-issues">
            <li v-for="(i, k) in fieldIssues('description')" :key="k">{{ i.message }}</li>
          </ul>
        </label>

        <label class="ed-field">
          <span class="ed-label">标签<em>最多 8 个，用于匹配意图</em></span>
          <AppInput :model-value="tagText" placeholder="用顿号或逗号分隔" @update:model-value="tagText = $event" />
        </label>

        <div v-for="f in PROSE_FIELDS" :key="f.key" class="ed-field">
          <span class="ed-label">{{ f.label }}</span>
          <span class="ed-hint">{{ f.hint }}</span>
          <AppTextarea v-model="definition[f.key]" :rows="6" :placeholder="f.hint" />
          <ul v-if="fieldIssues(f.key).length" class="ed-issues">
            <li v-for="(i, k) in fieldIssues(f.key)" :key="k">{{ i.message }}</li>
          </ul>
        </div>

        <div class="ed-field">
          <span class="ed-label">
            启动示例
            <em>最多 6 条，给内核一个可用的开场</em>
          </span>
          <div class="ed-sublist">
            <div v-for="(ex, i) in definition.examples" :key="i" class="ed-subitem">
              <div class="ed-subrow">
                <AppInput v-model="ex.id" placeholder="示例 id" :maxlength="64" />
                <AppInput
                  :model-value="ex.title ?? ''"
                  placeholder="标题（可选）"
                  :maxlength="120"
                  @update:model-value="setExampleTitle(i, $event)"
                />
                <button class="ed-mini danger" @click="removeExample(i)">删除</button>
              </div>
              <AppTextarea v-model="ex.prompt" :rows="2" placeholder="示例的完整输入或期望的回应" />
              <ul v-if="fieldIssues(`examples.${i}.id`).length" class="ed-issues">
                <li v-for="(it, k) in fieldIssues(`examples.${i}.id`)" :key="k">{{ it.message }}</li>
              </ul>
            </div>
            <button class="ed-mini" @click="addExample">+ 添加示例</button>
          </div>
        </div>

        <div class="ed-field">
          <span class="ed-label">
            Skill 依赖
            <em>最多 32 条，声明要先装载哪些技能</em>
          </span>
          <div class="ed-sublist">
            <div v-for="(s, i) in definition.skill_requirements" :key="i" class="ed-subrow">
              <AppInput v-model="s.name" placeholder="Skill 名称" />
              <button class="ed-mini danger" @click="removeSkill(i)">删除</button>
            </div>
            <button class="ed-mini" @click="addSkill">+ 添加 Skill 依赖</button>
          </div>
        </div>
      </div>

      <aside class="ed-side">
        <div class="ed-preview">
          <div class="ed-preview-head">
            <span>persona 预览</span>
            <span class="ed-tokens">{{ personaTokens }} tokens</span>
          </div>
          <pre class="ed-pre">{{ personaText }}</pre>
        </div>

        <div class="ed-check">
          <div class="ed-check-head">
            <span>发布检查</span>
            <span v-if="validating" class="ed-state">校验中…</span>
          </div>
          <p v-if="!blocking.length && !loading" class="ed-ok">定义已通过全部校验，可以发布。</p>
          <p v-else-if="loading" class="ed-state">正在读取草稿…</p>
          <ul v-else class="ed-check-list">
            <li v-for="(i, k) in blocking" :key="k">
              <code>{{ i.path || i.code }}</code> {{ i.message }}
            </li>
          </ul>
          <button class="ed-mini" @click="showCreate = true">另存为新专家…</button>
        </div>
      </aside>
    </div>

    <AppModal
      v-model:open="showCreate"
      title="另存为新专家"
      size="sm"
      @close="showCreate = false"
    >
      <div class="ed-create">
        <label>
          <span>新专家 id</span>
          <AppInput v-model="newExpertId" placeholder="例如：code-review" mono />
        </label>
        <p class="ed-hint">当前表单内容会被整体复制过去，原草稿不变。</p>
        <p v-if="createError" class="ed-err">{{ createError }}</p>
      </div>
      <template #footer>
        <button class="ed-btn" @click="showCreate = false">取消</button>
        <button class="ed-btn primary" :disabled="!newExpertId.trim()" @click="createDraft">创建</button>
      </template>
    </AppModal>

    <PublishConfirmDialog
      :open="showConfirm"
      :challenge="challenge"
      :expert-name="definition.name"
      :publishing="publishing"
      @cancel="showConfirm = false"
      @confirmed="onConfirmed"
    />
  </section>
</template>

<style src="./ExpertDraftEditor.css" scoped></style>
