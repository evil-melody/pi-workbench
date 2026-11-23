<script setup lang="ts">
import { t } from '@/i18n'
/**
 * 专家中心详情 —— ExpertDefinition 表单（WorkBuddy 式融入）。
 *
 * 字段分两层，这是刻意的产品边界：
 *   · 可写 = 提示词类（名称 / 描述 / 标签 / 四段人格 / 启动示例 / 停止条件）。
 *     用户改的是「这个角色怎么说话、怎么交付」。
 *   · 只读可查 = 执行配置（执行器 / 模型 / 硬规则 / 工具门 / 拒绝模式 / MCP /
 *     技能要求 / 迭代上限 / 工具映射）。这些决定「它能碰什么、真用什么跑」，
 *     放开给用户等于让安全边界变成可编辑文本；但必须看得見 —— 看不见的能力边界
 *     比没有边界更危险（LoopForge 的显式能力边界）。
 *
 * 四段式人格（角色定位 / 工作方法 / 行为边界 / 交付物）而不是一整段自由文本：
 * 写坏了能定位到具体字段，拼进 persona 时也知道是哪一段出了问题。
 *
 * 校验是「编辑器内实时 + 后端权威」双轨：
 *   本地只做即时提示（输入体验），是否可发布由 expert_validate 与 expert_publish 决定。
 * persona 预览走后端 expert_persona_preview：编译规则与前端猜测只会漂移，
 * 所以预览的唯一真源在后端。
 * 保存走草稿修订号乐观锁，别人改过就报 revision-conflict 而不是静默覆盖。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppTextarea from '@/components/ui/AppTextarea.vue'
import AppModal from '@/components/ui/AppModal.vue'
import PublishConfirmDialog from './PublishConfirmDialog.vue'
import { toolsList } from '@/composables/useTools'
import {
  describeExpertError,
  emptyDefinition,
  estimateTokens,
  expertConfirm,
  expertDelete,
  expertDraftLoad,
  expertDraftSave,
  expertPublish,
  expertRequestConfirmation,
  expertValidate,
  expertPersonaPreview,
  issuesFor,
  type ConfirmationRequest,
  type DomainIssue,
  type ExpertDefinition,
  type ExpertDraft,
  type ExpertPublication,
  type ExpertPersonaPreview,
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
  deleted: [id: string]
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

// hint = 字段说明（label 下一行小字）；example = 真实例子（输入框 placeholder）。
// 占位符必须是可照抄的句子，不能是「以什么形式交付」这类元话术——用户看了还是不会写。
const PROSE_FIELDS = computed(() => [
  {
    key: 'role',
    label: t('角色定位'),
    hint: t('你是谁、擅长什么、以什么口吻说话。'),
    example: t('例：你是资深后端工程师，擅长 Go 与分布式存储，结论先行、不绕弯。'),
  },
  {
    key: 'methodology',
    label: t('工作方法'),
    hint: t('按什么顺序推进任务、遇到不确定时怎么处理。'),
    example: t('例：先读 diff 与相关测试定位根因，再给最小修复，最后补回归验证。'),
  },
  {
    key: 'boundaries',
    label: t('行为边界'),
    hint: t('绝对不能做的事，越界时必须明说。'),
    example: t('例：不碰生产配置、不删测试；不确定时说明假设，而不是猜一个答案。'),
  },
  {
    key: 'deliverables',
    label: t('交付物'),
    hint: t('最终以什么形式交付，格式与颗粒度要求。'),
    example: t('例：一份评审清单：问题、影响位置、修复建议，按严重程度排序。'),
  },
] as const)

const tagText = computed({
  get: () => definition.value.tags.join('、'),
  set: (raw: string) => {
    definition.value.tags = raw
      .split(/[,，、\s]+/)
      .map((t) => t.trim())
      .filter(Boolean)
  },
})

/** 内核实际提供的工具清单：只读展示时用来标注「哪些是内核当前认识的」。 */
const toolCatalog = ref<string[]>([])
onMounted(async () => {
  try {
    toolCatalog.value = (await toolsList()).catalog
  } catch {
    toolCatalog.value = []
  }
})

/** 老草稿可能没有这个字段：模板里统一走这个 computed，避免可选链铺满模板。 */
const toolMappings = computed(() => definition.value.tool_mapping ?? [])

/** 来源是草稿外层元信息：只展示，不允许在编辑器里改。 */
const source = ref<'local' | 'imported'>('local')
const importedFrom = ref('')

/**
 * persona 预览的真源在后端（expert_persona_preview）：
 * 前端复刻编译规则迟早与 compile_persona_prefix 漂移，
 * 「预览里看得见、运行时不是这份」是最坑人的状态。
 */
const preview = ref<ExpertPersonaPreview | null>(null)
let previewSeq = 0
async function runPreview() {
  const seq = ++previewSeq
  try {
    const res = await expertPersonaPreview(definition.value)
    if (seq === previewSeq) preview.value = res
  } catch {
    // 后端不可用时退回本地拼装，至少让人格文本可预览（降级只影响侧栏）。
    if (seq === previewSeq) preview.value = null
  }
}

const personaText = computed(() => {
  const backend = preview.value?.full
  if (backend) return backend
  const d = definition.value
  const parts = [t('你是「{0}」。', [d.name]), '', t('## 角色定位'), d.role.trim()]
  if (d.methodology.trim()) parts.push('', t('## 工作方法'), d.methodology.trim())
  if (d.boundaries.trim()) parts.push('', t('## 行为边界'), d.boundaries.trim())
  if (d.deliverables.trim()) parts.push('', t('## 交付物'), d.deliverables.trim())
  if (d.stop_condition.trim()) parts.push('', t('## 停止条件'), d.stop_condition.trim())
  const rules = (d.rules ?? '').trim()
  if (rules) parts.push('', t('## 硬规则'), rules)
  if (d.tags.length) parts.push('', t('## 适用标签'), d.tags.join('、'))
  return parts.join('\n')
})

const personaTokens = computed(() => estimateTokens(personaText.value))

/** 只读执行配置的展示值（缺省值要说人话，不许留空白格）。 */
const execDisplay = computed(
  () => preview.value?.executor ?? definition.value.executor ?? null,
)
const modelDisplay = computed(
  () => preview.value?.model ?? definition.value.model ?? null,
)
const mcpDisplay = computed(
  () => preview.value?.mcp_servers ?? definition.value.mcp_servers ?? [],
)
/** rules 是可选字段：模板里统一走这个 computed，避免到处 ??。 */
const rulesText = computed(() => (definition.value.rules ?? '').trim())
const skillNamesDisplay = computed(
  () =>
    preview.value?.skill_names ??
    definition.value.skill_requirements.map((r) => r.name).filter(Boolean),
)

const blocking = computed(() => issues.value.filter((i) => i.code !== 'definition/notice'))
const notices = computed(() => issues.value.filter((i) => i.code === 'definition/notice'))
const canPublish = computed(() => !loading.value && blocking.value.length === 0 && !publishBusy.value)

function fieldIssues(path: string) {
  // notice（空工作方法/交付物）不在字段旁唠叨：WorkBuddy 没有这种提示，
  // 每段下面挂一行黄字只会增加噪音。它统一聚合到右侧发布检查区，一行说完。
  return issuesFor(issues.value, path).filter((i) => i.code !== 'definition/notice')
}

/** notice 聚合：把为空的可选段收成一句「建议补全 X、Y」。
 *  role/boundaries 与 methodology/deliverables 同级——全部降为非阻塞后，
 *  缺什么都在这一行说，不再让发布按钮卡死。 */
const NOTICE_LABELS: Record<string, string> = {
  role: t('角色定位'),
  boundaries: t('行为边界'),
  methodology: t('工作方法'),
  deliverables: t('交付物'),
}
const noticeSummary = computed(() => {
  const labels = notices.value
    .map((i) => (i.path ? NOTICE_LABELS[i.path] : undefined))
    .filter((s): s is string => !!s)
  if (!labels.length) return ''
  return t('建议补全「{0}」，不阻塞发布。', [labels.join('、')])
})

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

/** 老草稿没有运行约束字段：读入时补齐，避免模板里访问 undefined。 */
function withRuntimeDefaults(definition: ExpertDefinition): ExpertDefinition {
  return {
    ...definition,
    allowed_tools: definition.allowed_tools ?? [],
    denied_patterns: definition.denied_patterns ?? [],
    stop_condition: definition.stop_condition ?? '',
    max_iterations: definition.max_iterations ?? null,
    tool_mapping: definition.tool_mapping ?? [],
    executor: definition.executor ?? null,
    model: definition.model ?? null,
    rules: definition.rules ?? '',
    mcp_servers: definition.mcp_servers ?? [],
  }
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
    // 校验与预览同节奏：都是输入停了才跑，避免每键一次 IPC。
    saveTimer = window.setTimeout(() => {
      void runValidate()
      void runPreview()
    }, 260)
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
      definition.value = withRuntimeDefaults(draft.definition)
      revision.value = draft.revision
      digest.value = draft.digest
      source.value = draft.source ?? 'local'
      importedFrom.value = draft.imported_from ?? ''
    } else {
      definition.value = emptyDefinition()
      revision.value = 0
      digest.value = ''
      source.value = 'local'
      importedFrom.value = ''
    }
  } catch (e: unknown) {
    loadError.value = describeExpertError(e, t('草稿读取失败'))
  }
  digestDirty.value = false
  loading.value = false
  await Promise.all([runValidate(), runPreview()])
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
    source.value = draft.source ?? source.value
    importedFrom.value = draft.imported_from ?? importedFrom.value
    digestDirty.value = false
    saveNotice.value = t('已保存为修订 #{0}', [draft.revision])
    emit('saved', draft)
  } catch (e: unknown) {
    saveError.value = describeExpertError(e, t('保存失败'))
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
    saveError.value = describeExpertError(e, t('申请发布授权失败'))
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
    publishNotice.value = t('已发布「{0}」，persona 写入 {1}', [pub.name, pub.persona_path])
    digestDirty.value = false
    emit('published', pub)
  } catch (e: unknown) {
    publishError.value = describeExpertError(e, t('发布失败'))
  }
  publishing.value = false
}

const publishError = ref('')

/** 删除专家：二次确认，只清本专家的文件；journal 历史不受影响。 */
const showDelete = ref(false)
const deleting = ref(false)
async function confirmDelete() {
  deleting.value = true
  saveError.value = ''
  try {
    await expertDelete(props.expertId, props.projectRoot ?? null)
    showDelete.value = false
    emit('deleted', props.expertId)
  } catch (e: unknown) {
    saveError.value = describeExpertError(e, t('删除失败'))
  }
  deleting.value = false
}

async function createDraft() {
  const id = newExpertId.value.trim()
  if (!id) return
  createError.value = ''
  try {
    // 新 id 尚无草稿，后端 revision 从 0 起算；definition 直接沿用当前表单内容。
    const draft = await expertDraftSave(id, withRuntimeDefaults(definition.value), 0)
    definition.value = withRuntimeDefaults(draft.definition)
    revision.value = draft.revision
    digest.value = draft.digest
    digestDirty.value = false
    showCreate.value = false
    newExpertId.value = ''
    saveNotice.value = t('已另存为新专家「{0}」，修订 #{1}', [id, draft.revision])
    emit('saved', draft)
  } catch (e: unknown) {
    createError.value = describeExpertError(e, t('另存失败'))
  }
}

function addExample() {
  definition.value.examples.push({ id: `ex${definition.value.examples.length + 1}`, title: '', prompt: '' })
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

defineExpose({ load })
</script>

<template>
  <section class="ed">
    <header class="ed-head">
      <div class="ed-head-main">
        <h3>{{ t('专家草稿') }}</h3>
        <span class="ed-meta">{{ t('修订 #{0}', [revision || '—']) }}<template v-if="digest">{{ t('· 摘要 {0}…', [digest.slice(0, 10)]) }}</template>
          <template v-if="digestDirty">{{ t('· 有未保存改动') }}</template>
        </span>
        <span class="ed-source" :data-source="source" :title="importedFrom || undefined">
          {{ source === 'imported' ? t('导入自 {0}', [importedFrom || t('外部插件')]) : t('本地创建') }}
        </span>
      </div>
      <div class="ed-head-actions">
        <span v-if="loading" class="ed-state">{{ t('读取中…') }}</span>
        <AppButton variant="text" size="sm" class="ed-mini danger" :disabled="loading || deleting" @click="showDelete = true">{{ t('删除专家') }}</AppButton>
        <AppButton variant="secondary" class="ed-btn" :disabled="saving || loading" @click="save">{{ saving ? t('保存中…') : t('保存草稿') }}</AppButton>
        <AppButton
          variant="primary"
          class="ed-btn primary"
          :disabled="!canPublish || publishing"
          :title="blocking.length ? t('还有校验问题待解决') : t('发布需要一次显式确认')"
          @click="requestChallenge"
        >
          {{ publishing ? t('发布中…') : t('发布') }}
        </AppButton>
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
          <span class="ed-label">{{ t('专家 id') }}<em>{{ t('发布后作为唯一标识') }}</em></span>
          <AppInput
            :model-value="expertId"
            readonly
            mono
            :placeholder="expertId"
          />
        </label>

        <label class="ed-field">
          <span class="ed-label">{{ t('名称') }}</span>
          <AppInput v-model="definition.name" :placeholder="t('例如：代码评审专家')" :maxlength="80" />
          <ul v-if="fieldIssues('name').length" class="ed-issues">
            <li v-for="(i, k) in fieldIssues('name')" :key="k">{{ i.message }}</li>
          </ul>
        </label>

        <label class="ed-field">
          <span class="ed-label">{{ t('描述') }}</span>
          <AppTextarea v-model="definition.description" :rows="2" :placeholder="t('一句话说明这个专家解决什么问题')" />
          <ul v-if="fieldIssues('description').length" class="ed-issues">
            <li v-for="(i, k) in fieldIssues('description')" :key="k">{{ i.message }}</li>
          </ul>
        </label>

        <label class="ed-field">
          <span class="ed-label">{{ t('标签') }}<em>{{ t('最多 8 个，用于匹配意图') }}</em></span>
          <AppInput :model-value="tagText" :placeholder="t('用顿号或逗号分隔')" @update:model-value="tagText = $event" />
        </label>

        <div v-for="f in PROSE_FIELDS" :key="f.key" class="ed-field">
          <span class="ed-label">{{ f.label }}</span>
          <span class="ed-hint">{{ f.hint }}</span>
          <AppTextarea v-model="definition[f.key]" :rows="6" :placeholder="f.example" />
          <ul v-if="fieldIssues(f.key).length" class="ed-issues">
            <li v-for="(i, k) in fieldIssues(f.key)" :key="k" :class="{ notice: i.code === 'definition/notice' }">{{ i.message }}</li>
          </ul>
        </div>

        <div class="ed-field">
          <span class="ed-label">{{ t('启动示例') }}<em>{{ t('最多 6 条，给内核一个可用的开场') }}</em>
          </span>
          <div class="ed-sublist">
            <div v-for="(ex, i) in definition.examples" :key="i" class="ed-subitem">
              <div class="ed-subrow">
                <AppInput v-model="ex.id" :placeholder="t('示例 id')" :maxlength="64" />
                <AppInput
                  :model-value="ex.title ?? ''"
                  :placeholder="t('标题（可选）')"
                  :maxlength="120"
                  @update:model-value="setExampleTitle(i, $event)"
                />
                <AppButton variant="text" size="sm" class="ed-mini danger" @click="removeExample(i)">{{ t('删除') }}</AppButton>
              </div>
              <AppTextarea v-model="ex.prompt" :rows="2" :placeholder="t('示例的完整输入或期望的回应')" />
              <ul v-if="fieldIssues(`examples.${i}.id`).length" class="ed-issues">
                <li v-for="(it, k) in fieldIssues(`examples.${i}.id`)" :key="k">{{ it.message }}</li>
              </ul>
            </div>
            <AppButton variant="text" size="sm" class="ed-mini" @click="addExample">{{ t('+ 添加示例') }}</AppButton>
          </div>
        </div>

        <!-- ── 执行配置：可查看，只读（能力边界不是可编辑文本） ── -->
        <div class="ed-readonly-head">
          <span class="ed-readonly-title">{{ t('执行配置') }}</span>
          <span class="ed-readonly-note">{{ t('只读 · 由专家包定义与发布流程决定；如需更改请重新导入或联系维护者') }}</span>
        </div>

        <div class="ed-field readonly">
          <span class="ed-label">{{ t('执行器') }}<em>{{ t('真正跑这个角色的 agent CLI') }}</em></span>
          <p class="ed-ro-value mono-cell">
            {{ execDisplay || t('默认（Pi 内核）') }}
          </p>
        </div>

        <div class="ed-field readonly">
          <span class="ed-label">{{ t('模型') }}</span>
          <p class="ed-ro-value mono-cell">{{ modelDisplay || t('跟随会话配置') }}</p>
        </div>

        <div class="ed-field readonly">
          <span class="ed-label">{{ t('硬规则') }}<em>{{ t('以约束形式编译进 persona 尾部') }}</em></span>
          <pre v-if="rulesText" class="ed-ro-pre">{{ rulesText }}</pre>
          <p v-else class="ed-ro-value muted-cell">{{ t('未设置') }}</p>
        </div>

        <div class="ed-field readonly">
          <span class="ed-label">{{ t('可用工具') }}<em>{{ t('空 = 不限制；越界工具会被工具门拦截') }}</em></span>
          <div v-if="definition.allowed_tools.length" class="ed-chiprow">
            <span
              v-for="tool in definition.allowed_tools"
              :key="tool"
              class="ed-chip"
              :class="{ ghost: toolCatalog.length && !toolCatalog.includes(tool) }"
              :title="toolCatalog.length && !toolCatalog.includes(tool) ? t('内核当前不提供该工具') : undefined"
            >
              {{ tool }}
            </span>
          </div>
          <p v-else class="ed-ro-value muted-cell">{{ t('不限制') }}</p>
        </div>

        <div class="ed-field readonly">
          <span class="ed-label">{{ t('拒绝模式') }}<em>{{ t('bash 命令命中任一片段即拦截') }}</em></span>
          <div v-if="definition.denied_patterns.length" class="ed-chiprow">
            <span v-for="p in definition.denied_patterns" :key="p" class="ed-chip deny">{{ p }}</span>
          </div>
          <p v-else class="ed-ro-value muted-cell">{{ t('无') }}</p>
        </div>

        <div class="ed-field readonly">
          <span class="ed-label">MCP<em>{{ t('该角色可用的 MCP 服务；空 = 不限制') }}</em></span>
          <div v-if="mcpDisplay.length" class="ed-chiprow">
            <span v-for="m in mcpDisplay" :key="m" class="ed-chip">{{ m }}</span>
          </div>
          <p v-else class="ed-ro-value muted-cell">{{ t('不限制') }}</p>
        </div>

        <div class="ed-field readonly">
          <span class="ed-label">{{ t('技能要求') }}</span>
          <div v-if="skillNamesDisplay.length" class="ed-chiprow">
            <span v-for="s in skillNamesDisplay" :key="s" class="ed-chip">{{ s }}</span>
          </div>
          <p v-else class="ed-ro-value muted-cell">{{ t('无') }}</p>
        </div>

        <div class="ed-field readonly">
          <span class="ed-label">{{ t('迭代上限') }}<em>{{ t('单轮最大迭代次数') }}</em></span>
          <p class="ed-ro-value mono-cell">
            {{ definition.max_iterations ?? t('内核默认') }}
          </p>
        </div>

        <div v-if="toolMappings.length" class="ed-field readonly">
          <span class="ed-label">{{ t('工具映射记录') }}<em>{{ t('导入时的决定，仅追溯') }}</em></span>
          <ul class="ed-maplist">
            <li v-for="(m, i) in toolMappings" :key="i" class="ed-maprow">
              <code>{{ m.from }}</code>
              <span class="ed-maparrow">→</span>
              <code>{{ m.to ?? t('忽略') }}</code>
            </li>
          </ul>
        </div>

        <div class="ed-field">
          <span class="ed-label">{{ t('停止条件') }}<em>{{ t('写进 persona：满足什么条件就收手') }}</em></span>
          <AppTextarea v-model="definition.stop_condition" :rows="3" :placeholder="t('例如：拿到测试结果并给出结论后停止，不再继续改代码')" />
          <ul v-if="fieldIssues('stopCondition').length" class="ed-issues">
            <li v-for="(i, k) in fieldIssues('stopCondition')" :key="k">{{ i.message }}</li>
          </ul>
        </div>
      </div>

      <aside class="ed-side">
        <div class="ed-preview">
          <div class="ed-preview-head">
            <span>{{ t('persona 预览') }}</span>
            <span class="ed-tokens">{{ personaTokens }} tokens</span>
          </div>
          <pre class="ed-pre">{{ personaText }}</pre>
        </div>

        <div class="ed-check">
          <div class="ed-check-head">
            <span>{{ t('发布检查') }}</span>
            <span v-if="validating" class="ed-state">{{ t('校验中…') }}</span>
          </div>
          <template v-if="loading">
            <p class="ed-state">{{ t('正在读取草稿…') }}</p>
          </template>
          <template v-else>
            <p v-if="!blocking.length && !noticeSummary" class="ed-ok">{{ t('定义已通过全部校验，可以发布。') }}</p>
            <p v-else-if="!blocking.length" class="ed-ok">
              {{ t('可以发布。') }}
              <span class="ed-check-notice">{{ noticeSummary }}</span>
            </p>
            <ul v-else class="ed-check-list blocking">
              <li v-for="(i, k) in blocking" :key="k">
                <code>{{ i.path || i.code }}</code> {{ i.message }}
              </li>
            </ul>
            <!-- notice 聚合为一行琥珀提示：WorkBuddy 没有逐字段唠叨，我们也不做。
                 发不发都行，只回答「还差什么能更稳」。 -->
            <p v-if="blocking.length && noticeSummary" class="ed-check-notice">
              {{ noticeSummary }}
            </p>
          </template>
          <AppButton variant="text" size="sm" class="ed-mini" @click="showCreate = true">{{ t('另存为新专家…') }}</AppButton>
        </div>
      </aside>
    </div>

    <AppModal
      v-model:open="showCreate"
      :title="t('另存为新专家')"
      size="sm"
      @close="showCreate = false"
    >
      <div class="ed-create">
        <label>
          <span>{{ t('新专家 id') }}</span>
          <AppInput v-model="newExpertId" :placeholder="t('例如：code-review')" mono />
        </label>
        <p class="ed-hint">{{ t('当前表单内容会被整体复制过去，原草稿不变。') }}</p>
        <p v-if="createError" class="ed-err">{{ createError }}</p>
      </div>
      <template #footer>
        <AppButton variant="secondary" class="ed-btn" @click="showCreate = false">{{ t('取消') }}</AppButton>
        <AppButton variant="primary" class="ed-btn primary" :disabled="!newExpertId.trim()" @click="createDraft">{{ t('创建') }}</AppButton>
      </template>
    </AppModal>

    <AppModal
      v-model:open="showDelete"
      :title="t('删除专家')"
      size="sm"
      @close="showDelete = false"
    >
      <p class="ed-hint">{{ t('将删除「{0}」的草稿、已发布定义与 persona；历史运行记录不会受影响。', [definition.name || props.expertId]) }}</p>
      <p v-if="saveError" class="ed-err">{{ saveError }}</p>
      <template #footer>
        <AppButton variant="secondary" class="ed-btn" @click="showDelete = false">{{ t('取消') }}</AppButton>
        <AppButton variant="primary" class="ed-btn primary" :disabled="deleting" @click="confirmDelete">{{ deleting ? t('删除中…') : t('确认删除') }}</AppButton>
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
