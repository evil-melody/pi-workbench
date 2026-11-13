<script setup lang="ts">
import { t } from '@/i18n'
/**
 * 外部专家导入（WorkBuddy 插件格式）。
 *
 * 只做一层最小映射：plugin.json + agents/*.md → 本应用专家草稿。
 * 映射不上的字段、内核里不存在的工具都在预览里逐条列出，由用户决定，
 * 不静默丢弃；冲突默认「跳过」，落盘由后端事务化完成（失败回滚）。
 */
import { computed, ref, watch } from 'vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppSelect, { type SelectOption } from '@/components/ui/AppSelect.vue'
import { toolsList } from '@/composables/useTools'
import {
  describeExpertError,
  expertImportApply,
  expertImportPreview,
  resolveImportedTools,
  type ImportApplyItem,
  type ImportExpertPreview,
  type ImportPreview,
} from '@/composables/useExperts'

const props = defineProps<{ open: boolean; existingIds: string[] }>()
const emit = defineEmits<{ close: []; imported: [ids: string[]] }>()

type ConflictChoice = 'skip' | 'overwrite' | 'rename'

const path = ref('')
const previewing = ref(false)
const applying = ref(false)
const error = ref('')
const preview = ref<ImportPreview | null>(null)
const catalog = ref<string[]>([])

/** 每个专家的冲突选择；默认跳过。 */
const conflicts = ref<Record<string, string>>({})
const renameIds = ref<Record<string, string>>({})

/** 未映射工具未决策（默认值）：此时不允许导入。 */
const PENDING = ''
/** 显式忽略：写进定义的 tool_mapping 里是 `to: null`。 */
const IGNORE = '__ignore__'
/** 外部工具名 → 目标工具名 / IGNORE / PENDING。 */
const toolMaps = ref<Record<string, Record<string, string>>>({})

watch(
  () => props.open,
  (open) => {
    if (!open) return
    path.value = ''
    preview.value = null
    error.value = ''
    conflicts.value = {}
    renameIds.value = {}
    toolMaps.value = {}
    void loadCatalog()
  },
  { immediate: true },
)

async function loadCatalog() {
  try {
    catalog.value = (await toolsList()).catalog
  } catch {
    catalog.value = []
  }
}

const conflictOptions = computed<SelectOption[]>(() => [
  { value: 'skip', label: t('跳过'), hint: t('保留现有专家，不写入') },
  { value: 'overwrite', label: t('覆盖'), hint: t('用外部定义覆盖现有草稿') },
  { value: 'rename', label: t('改名'), hint: t('保留现有专家，另存为新 id') },
])

function toolOptions(issue: { suggestion: string | null }): SelectOption[] {
  return [
    { value: PENDING, label: t('待决定'), hint: t('未决定前不能导入') },
    { value: IGNORE, label: t('忽略该工具'), hint: t('导入后不加入允许工具集') },
    ...catalog.value.map((name) => ({
      value: name,
      label: name,
      hint: name === issue.suggestion ? t('建议映射') : undefined,
    })),
  ]
}

async function runPreview() {
  const target = path.value.trim()
  if (!target) return
  previewing.value = true
  error.value = ''
  preview.value = null
  try {
    if (!catalog.value.length) await loadCatalog()
    const result = await expertImportPreview(target, catalog.value)
    preview.value = result
    for (const expert of result.experts) {
      conflicts.value[expert.id] = 'skip'
      renameIds.value[expert.id] = `${expert.id}-imported`
      toolMaps.value[expert.id] = Object.fromEntries(
        expert.unmapped_tools.map((tool) => [tool.name, PENDING]),
      )
    }
  } catch (e) {
    error.value = describeExpertError(e, t('预览失败，请检查路径与文件结构'))
  } finally {
    previewing.value = false
  }
}

function mappedTools(expert: ImportExpertPreview): string[] {
  return resolveImportedTools(expert.definition, mappingOf(expert)).allowed_tools
}

/** 把界面里的 IGNORE / PENDING 翻译成 resolveImportedTools 认识的 null / 工具名。 */
function mappingOf(expert: ImportExpertPreview): Record<string, string | null> {
  const mapping: Record<string, string | null> = {}
  for (const [from, value] of Object.entries(toolMaps.value[expert.id] ?? {})) {
    mapping[from] = value === IGNORE ? null : value
  }
  return mapping
}

/** 会被本次导入的专家（冲突且选择跳过的不算）。 */
function willImport(expert: ImportExpertPreview): boolean {
  return !expert.conflict || conflicts.value[expert.id] !== 'skip'
}

function toolAnchor(expertId: string, tool: string): string {
  return `import-tool-${expertId}-${tool}`
}

/** 尚未决定的未映射工具：非空时禁止导入。 */
const pendingItems = computed(() => {
  const items: { expertId: string; expertName: string; tool: string; anchor: string }[] = []
  for (const expert of preview.value?.experts ?? []) {
    if (!willImport(expert)) continue
    for (const tool of expert.unmapped_tools) {
      if ((toolMaps.value[expert.id]?.[tool.name] ?? PENDING) === PENDING) {
        items.push({
          expertId: expert.id,
          expertName: expert.name,
          tool: tool.name,
          anchor: toolAnchor(expert.id, tool.name),
        })
      }
    }
  }
  return items
})

function pendingOf(expert: ImportExpertPreview): number {
  return pendingItems.value.filter((item) => item.expertId === expert.id).length
}

function jumpTo(anchor: string) {
  document.getElementById(anchor)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

/** 改名后的 id 与现有专家或同批导入项重名时给出提示。 */
function renameConflict(expert: ImportExpertPreview): boolean {
  const id = renameId(expert)
  return props.existingIds.includes(id) || id === expert.id
}

function renameId(expert: ImportExpertPreview): string {
  return (renameIds.value[expert.id] ?? '').trim()
}

const importCount = computed(() => {
  const list = preview.value?.experts ?? []
  return list.filter((e) => conflicts.value[e.id] !== 'skip' || !e.conflict).length
})

const canApply = computed(() => {
  const list = preview.value?.experts ?? []
  if (!list.length) return false
  // 未映射工具必须逐个显式决定：忽略或指定替代工具，不能默认吞掉。
  if (pendingItems.value.length) return false
  return list.every((e) => {
    if (e.conflict && conflicts.value[e.id] === 'skip') return true
    if (conflicts.value[e.id] !== 'rename') return true
    return !!renameId(e) && !renameConflict(e)
  })
})

async function applyImport() {
  const list = preview.value?.experts ?? []
  const items: ImportApplyItem[] = []
  for (const expert of list) {
    const choice = (conflicts.value[expert.id] ?? 'skip') as ConflictChoice
    if (expert.conflict && choice === 'skip') continue
    const id = choice === 'rename' ? renameId(expert) : expert.id
    items.push({
      id,
      definition: resolveImportedTools(expert.definition, mappingOf(expert)),
      conflict: choice,
      source_path: expert.source_path,
    })
  }
  if (!items.length) {
    emit('close')
    return
  }
  applying.value = true
  error.value = ''
  try {
    const results = await expertImportApply(items)
    emit('imported', results.filter((r) => r.action !== 'skipped').map((r) => r.id))
    emit('close')
  } catch (e) {
    error.value = describeExpertError(e, t('导入失败，未写入任何草稿'))
  } finally {
    applying.value = false
  }
}
</script>

<template>
  <AppModal :open="open" :title="t('导入外部专家')" size="lg" @close="emit('close')">
    <div class="import-expert">
      <label class="import-path">
        <span>{{ t('插件目录或角色文件') }}</span>
        <AppInput
          v-model="path"
          :placeholder="t('例如：~/.workbuddy/plugins/cache/experts/code-crew/1.0.0')"
          mono
          @keydown.enter="runPreview"
        />
      </label>
      <div class="import-actions">
        <AppButton variant="secondary" :disabled="!path.trim() || previewing" @click="runPreview">
          {{ previewing ? t('识别中…') : t('识别并预览') }}
        </AppButton>
        <span class="import-hint">{{ t('支持 WorkBuddy 的 plugin.json + agents/*.md，也接受单个角色 md。') }}</span>
      </div>

      <p v-if="error" class="form-error">{{ error }}</p>

      <template v-if="preview">
        <p class="import-summary">
          {{ t('识别到 {0} 个专家', [preview.experts.length]) }}
          <span v-if="preview.plugin" class="mono">{{ preview.plugin }}</span>
        </p>

        <div v-if="pendingItems.length" class="import-block warn import-pending">
          <strong>{{ t('还有 {0} 项未映射工具待处理，处理后才能导入', [pendingItems.length]) }}</strong>
          <ul class="import-pending-list">
            <li v-for="item in pendingItems" :key="item.anchor">
              <AppButton variant="text" size="sm" @click="jumpTo(item.anchor)">
                {{ t('{0} · {1}', [item.expertName, item.tool]) }}
              </AppButton>
            </li>
          </ul>
        </div>

        <div v-if="preview.unmapped_fields.length" class="import-block">
          <strong>{{ t('插件级字段未映射（不会写入）') }}</strong>
          <ul>
            <li v-for="field in preview.unmapped_fields" :key="field.field">
              <code>{{ field.field }}</code>{{ field.reason }}
            </li>
          </ul>
        </div>

        <article v-for="expert in preview.experts" :key="expert.id" class="import-card">
          <header>
            <div>
              <strong>{{ expert.name }}</strong>
              <span class="mono">{{ expert.id }}</span>
            </div>
            <span v-if="expert.conflict" class="import-conflict">{{ t('同名专家已存在') }}</span>
            <span v-if="pendingOf(expert)" class="import-pending-tag">
              {{ t('待处理 {0} 项', [pendingOf(expert)]) }}
            </span>
          </header>

          <p class="import-role">{{ expert.role || t('（角色正文为空）') }}</p>

          <div class="import-fields">
            <span>{{ t('工具：{0}', [mappedTools(expert).length ? mappedTools(expert).join('、') : t('不限制')]) }}</span>
            <span v-if="expert.definition.stop_condition">{{ t('停止条件：{0}', [expert.definition.stop_condition.split('\n')[0]]) }}</span>
          </div>

          <div v-if="expert.warnings.length" class="import-block warn">
            <strong>{{ t('提醒') }}</strong>
            <ul><li v-for="w in expert.warnings" :key="w">{{ w }}</li></ul>
          </div>

          <div v-if="expert.unmapped_fields.length" class="import-block">
            <strong>{{ t('字段未映射（不会写入）') }}</strong>
            <ul>
              <li v-for="field in expert.unmapped_fields" :key="field.field">
                <code>{{ field.field }}</code>{{ field.reason }}
              </li>
            </ul>
          </div>

          <div v-if="expert.unmapped_tools.length" class="import-block warn">
            <strong>{{ t('内核里没有这些工具，请决定映射或忽略') }}</strong>
            <div
              v-for="tool in expert.unmapped_tools"
              :id="toolAnchor(expert.id, tool.name)"
              :key="tool.name"
              class="import-tool-row"
            >
              <code>{{ tool.name }}</code>
              <AppSelect
                v-model="toolMaps[expert.id][tool.name]"
                :options="toolOptions(tool)"
                width="220px"
              />
            </div>
          </div>

          <div v-if="expert.conflict" class="import-conflict-row">
            <span>{{ t('冲突处理') }}</span>
            <AppSelect
              v-model="conflicts[expert.id]"
              :options="conflictOptions"
              width="140px"
            />
            <AppInput
              v-if="conflicts[expert.id] === 'rename'"
              v-model="renameIds[expert.id]"
              mono
              :placeholder="t('新的专家 id')"
            />
          </div>
          <p v-if="expert.conflict && conflicts[expert.id] === 'rename' && renameConflict(expert)" class="form-error">
            {{ t('新 id 与现有专家重复，请换一个') }}
          </p>
        </article>
      </template>
    </div>

    <template #footer>
      <AppButton variant="secondary" @click="emit('close')">{{ t('取消') }}</AppButton>
      <AppButton variant="primary" :disabled="!canApply || applying" @click="applyImport">
        {{ applying ? t('导入中…') : t('导入 {0} 个专家', [importCount]) }}
      </AppButton>
    </template>
  </AppModal>
</template>

<style src="./ExpertImportDialog.css" scoped></style>
