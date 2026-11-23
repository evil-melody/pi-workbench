<script setup lang="ts">
import { t } from '@/i18n'
/**
 * 外部专家导入（WorkBuddy 插件格式）。
 *
 * 主路径是「一键扫描」：打开即摊开 ~/.workbuddy/plugins/cache/experts 里的
 * 全部包，勾选后批量预览、落草稿，团队包（expertType=team）顺手建一支同名
 * 专家团。手填路径保留为备选入口，单个包 / 单个角色 md 都能吃。
 *
 * 只做一层最小映射：映射不上的字段、内核里不存在的工具都在预览里逐条列出，
 * 由用户决定，不静默丢弃；冲突默认「跳过」，落盘由后端事务化完成（失败回滚）。
 */
import { computed, ref, watch } from 'vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppCheckbox from '@/components/ui/AppCheckbox.vue'
import AppSelect, { type SelectOption } from '@/components/ui/AppSelect.vue'
import { toolsList } from '@/composables/useTools'
import { agentTeamCreate } from '@/composables/useAgentOps'
import {
  describeExpertError,
  expertImportApply,
  expertImportPreview,
  expertImportScan,
  resolveImportedTools,
  type ImportApplyItem,
  type ImportExpertPreview,
  type ImportPreview,
  type ScanPackage,
  type ScanResult,
} from '@/composables/useExperts'

const props = defineProps<{ open: boolean; existingIds: string[] }>()
const emit = defineEmits<{
  close: []
  imported: [ids: string[]]
  teamsCreated: [names: string[], errors: string[]]
}>()

type ConflictChoice = 'skip' | 'overwrite' | 'rename'
type Mode = 'scan' | 'detail'

const mode = ref<Mode>('scan')
const path = ref('')
const previewing = ref(false)
const applying = ref(false)
const error = ref('')
const catalog = ref<string[]>([])

// ── 扫描态 ────────────────────────────────────────────────
const scan = ref<ScanResult | null>(null)
const scanning = ref(false)
/** slug → 是否勾选；解析失败的包强制不勾。 */
const checks = ref<Record<string, boolean>>({})

// ── 预览明细态 ────────────────────────────────────────────
/** key = 包 slug（手填路径用 'manual'）；顺序即展示顺序。 */
const previews = ref<Record<string, ImportPreview>>({})
const previewOrder = ref<string[]>([])
/** slug → 包展示名，明细卡片标注来源。 */
const packNames = ref<Record<string, string>>({})
/** slug → 团队包拓扑（仅扫描路径填充，手填路径不建团）。 */
const packTeams = ref<Record<string, ScanPackage>>({})

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
    resetAll()
    void loadCatalog().then(() => runScan())
  },
  { immediate: true },
)

function resetAll() {
  mode.value = 'scan'
  path.value = ''
  scan.value = null
  scanning.value = false
  checks.value = {}
  previews.value = {}
  previewOrder.value = []
  packNames.value = {}
  packTeams.value = {}
  error.value = ''
  conflicts.value = {}
  renameIds.value = {}
  toolMaps.value = {}
}

async function loadCatalog() {
  try {
    catalog.value = (await toolsList()).catalog
  } catch {
    catalog.value = []
  }
}

const selectedPackages = computed<ScanPackage[]>(() =>
  (scan.value?.packages ?? []).filter((p) => checks.value[p.slug] && !p.error),
)

const selectableCount = computed(
  () => (scan.value?.packages ?? []).filter((p) => !p.error).length,
)

const allChecked = computed(
  () => selectableCount.value > 0 && selectedPackages.value.length === selectableCount.value,
)

function toggleAll() {
  const next = !allChecked.value
  for (const pack of scan.value?.packages ?? []) {
    if (!pack.error) checks.value[pack.slug] = next
  }
}

async function runScan() {
  scanning.value = true
  error.value = ''
  try {
    if (!catalog.value.length) await loadCatalog()
    const result = await expertImportScan(catalog.value)
    scan.value = result
    checks.value = {}
    for (const pack of result.packages) {
      // 默认全选：符合「把 workbuddy 里所有的专家导进去」的直觉；
      // 冲突仍逐个走「跳过」默认值，不会覆盖现有专家。
      checks.value[pack.slug] = !pack.error
    }
  } catch (e) {
    error.value = describeExpertError(e, t('扫描 WorkBuddy 专家缓存失败'))
    scan.value = null
  } finally {
    scanning.value = false
  }
}

/** 勾选的包逐个走单包 preview（与手填路径同一链路，逻辑零重复），合并进明细。 */
async function goDetail() {
  const packs = selectedPackages.value
  if (!packs.length) return
  previewing.value = true
  error.value = ''
  try {
    for (const pack of packs) {
      if (previews.value[pack.slug]) continue
      const result = await expertImportPreview(pack.path, catalog.value)
      previews.value[pack.slug] = result
      previewOrder.value.push(pack.slug)
      packNames.value[pack.slug] = pack.name
      if (pack.is_team) packTeams.value[pack.slug] = pack
      initDecisions(result)
    }
    mode.value = 'detail'
  } catch (e) {
    error.value = describeExpertError(e, t('预览失败，请检查包结构后重试'))
  } finally {
    previewing.value = false
  }
}

/** 初始化决策；已有决策不覆盖（返回列表再加勾后回来仍保留）。 */
function initDecisions(result: ImportPreview) {
  for (const expert of result.experts) {
    if (conflicts.value[expert.id] === undefined) conflicts.value[expert.id] = 'skip'
    if (renameIds.value[expert.id] === undefined) renameIds.value[expert.id] = `${expert.id}-imported`
    if (toolMaps.value[expert.id] === undefined) {
      // 后端给了唯一候选就自动采纳：Read→read 这类大小写差异不该逼用户逐条点。
      // 没候选（Grep/Glob 这类内核根本没有的工具）默认忽略——这些工具在 Pi 里
      // 由 read/bash 覆盖，忽略不影响导入，也无需用户面对「待决定」猜选什么。
      toolMaps.value[expert.id] = Object.fromEntries(
        expert.unmapped_tools.map((tool) => [tool.name, tool.suggestion ?? IGNORE]),
      )
    }
  }
}

/** 备选入口：手填路径识别单包。 */
async function runPreviewPath() {
  const target = path.value.trim()
  if (!target) return
  previewing.value = true
  error.value = ''
  try {
    if (!catalog.value.length) await loadCatalog()
    const result = await expertImportPreview(target, catalog.value)
    const slug = 'manual'
    delete previews.value[slug]
    previews.value[slug] = result
    if (!previewOrder.value.includes(slug)) previewOrder.value.push(slug)
    const file = target.replace(/\/+$/, '').split('/').pop() ?? target
    packNames.value[slug] = file
    initDecisions(result)
    mode.value = 'detail'
  } catch (e) {
    error.value = describeExpertError(e, t('预览失败，请检查路径与文件结构'))
  } finally {
    previewing.value = false
  }
}

const conflictOptions = computed<SelectOption[]>(() => [
  { value: 'skip', label: t('跳过'), hint: t('保留现有专家，不写入') },
  { value: 'overwrite', label: t('覆盖'), hint: t('用外部定义覆盖现有草稿') },
  { value: 'rename', label: t('改名'), hint: t('保留现有专家，另存为新 id') },
])

function toolOptions(issue: { suggestion: string | null }): SelectOption[] {
  return [
    { value: IGNORE, label: t('忽略（内核没有）'), hint: t('导入后不加入允许工具集，不影响其他能力') },
    ...catalog.value.map((name) => ({
      value: name,
      label: name,
      hint: name === issue.suggestion ? t('建议映射') : undefined,
    })),
  ]
}

interface FlatExpert {
  expert: ImportExpertPreview
  slug: string
}

/** 全部明细包摊平，保持进入顺序。 */
const allExperts = computed<FlatExpert[]>(() =>
  previewOrder.value.flatMap((slug) =>
    (previews.value[slug]?.experts ?? []).map((expert) => ({ expert, slug })),
  ),
)

/** 插件级未映射字段跨包去重（27 个包的同类字段刷屏没有信息量）。 */
const unmappedFields = computed(() => {
  const seen = new Set<string>()
  const out: { field: string; reason: string }[] = []
  for (const slug of previewOrder.value) {
    for (const field of previews.value[slug]?.unmapped_fields ?? []) {
      if (seen.has(field.field)) continue
      seen.add(field.field)
      out.push(field)
    }
  }
  return out
})

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
  for (const { expert } of allExperts.value) {
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

/** 导入后该专家 id 的最终落点（改名走新 id）。 */
function finalId(expert: ImportExpertPreview): string {
  return conflicts.value[expert.id] === 'rename' ? renameId(expert) : expert.id
}

const importCount = computed(
  () => allExperts.value.filter(({ expert }) => conflicts.value[expert.id] !== 'skip' || !expert.conflict).length,
)

const canApply = computed(() => {
  const list = allExperts.value.map(({ expert }) => expert)
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
  const list = allExperts.value
  const items: ImportApplyItem[] = []
  for (const { expert } of list) {
    const choice = (conflicts.value[expert.id] ?? 'skip') as ConflictChoice
    if (expert.conflict && choice === 'skip') continue
    items.push({
      id: choice === 'rename' ? renameId(expert) : expert.id,
      definition: resolveImportedTools(expert.definition, mappingOf(expert)),
      conflict: choice,
      source_path: expert.source_path,
      // 头像源路径原样带回；后端按最终 id 复制到 avatars/<id>.<ext>。
      ...(expert.avatar_from ? { avatar_from: expert.avatar_from } : {}),
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
    const ids = results.filter((r) => r.action !== 'skipped').map((r) => r.id)
    const teams = await createImportedTeams(list)
    // 专家已落盘，建团失败不吞导入结果：交给父页面提示，清单里手动建团仍是可用路径。
    emit('imported', ids)
    emit('teamsCreated', teams.created, teams.errors)
    emit('close')
  } catch (e) {
    error.value = describeExpertError(e, t('导入失败，未写入任何草稿'))
  } finally {
    applying.value = false
  }
}

/**
 * 团队包导入后顺手建团：成员 = 包内全部 agent 的最终 id（跳过冲突的成员
 * 本来就在库里，改名成员用新 id，拓扑保持完整）。成员键用 `e:` 前缀，
 * 与 TeamsView 的候选键约定一致。失败逐条收集，不中断其余团队。
 */
async function createImportedTeams(
  list: FlatExpert[],
): Promise<{ created: string[]; errors: string[] }> {
  const created: string[] = []
  const errors: string[] = []
  for (const slug of previewOrder.value) {
    const pack = packTeams.value[slug]
    if (!pack) continue
    const idOf = new Map(list.map(({ expert }) => [expert.id, finalId(expert)]))
    const members = pack.member_ids.map((id) => `e:${idOf.get(id) ?? id}`)
    if (members.length < 2) continue
    const lead = pack.lead ? `e:${idOf.get(pack.lead) ?? pack.lead}` : undefined
    try {
      await agentTeamCreate(pack.name, members, 'sequential', lead)
      created.push(pack.name)
    } catch (e) {
      errors.push(t('「{0}」：{1}', [pack.name, describeExpertError(e, t('创建团队失败'))]))
    }
  }
  return { created, errors }
}

function backToScan() {
  mode.value = 'scan'
  error.value = ''
}

/** 扫描根的展示文案：~ 缩写，路径就是「之前的路径在哪里」的答案。 */
const rootLabel = computed(() => {
  const root = scan.value?.root ?? ''
  if (!root) return t('未找到 WorkBuddy 专家缓存目录')
  return root.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~')
})
</script>

<template>
  <AppModal :open="open" :title="t('导入外部专家')" size="lg" @close="emit('close')">
    <div class="import-expert">
      <p v-if="error" class="form-error">{{ error }}</p>

      <!-- ── 扫描态：WorkBuddy 缓存全量清单 ── -->
      <template v-if="mode === 'scan'">
        <div class="import-scan-head">
          <div class="import-root">
            <span class="import-root-label">{{ t('扫描目录') }}</span>
            <code class="mono">{{ rootLabel }}</code>
          </div>
          <AppButton variant="text" size="sm" :disabled="scanning" @click="runScan">
            {{ scanning ? t('扫描中…') : t('重新扫描') }}
          </AppButton>
        </div>

        <div v-if="scanning && !scan" class="import-empty">{{ t('正在读取专家缓存…') }}</div>
        <div v-else-if="scan && !scan.packages.length" class="import-empty">
          {{ scan.root ? t('缓存里没有任何专家包') : t('这台机器还没装过 WorkBuddy 专家；可在下方手动指定插件目录。') }}
        </div>

        <template v-else-if="scan">
          <div class="import-select-bar">
            <AppCheckbox
              :model-value="allChecked"
              :label="t('全选（{0} 个包）', [selectableCount])"
              @update:model-value="toggleAll()"
            />
            <span class="import-hint">
              {{ t('已选 {0} 个包 · {1} 位专家', [
                selectedPackages.length,
                selectedPackages.reduce((n, p) => n + p.experts.length, 0),
              ]) }}
            </span>
          </div>

          <ul class="import-pack-list">
            <li
              v-for="pack in scan.packages"
              :key="pack.slug"
              class="import-pack"
              :class="{ off: pack.error }"
            >
              <AppCheckbox
                v-model="checks[pack.slug]"
                :label="pack.name"
                :disabled="!!pack.error"
              />
              <span v-if="pack.is_team" class="import-badge team">{{ t('团队') }}</span>
              <span v-if="pack.conflict" class="import-badge">{{ t('有同名') }}</span>
              <span class="import-pack-meta mono">{{ pack.slug }}@{{ pack.version }}</span>
              <span class="import-pack-count">
                <template v-if="pack.error">{{ pack.error }}</template>
                <template v-else>
                  {{ t('{0} 位专家', [pack.experts.length]) }}
                  <template v-if="pack.is_team && pack.lead">
                    · {{ t('牵头 {0}', [pack.lead]) }}
                  </template>
                </template>
              </span>
            </li>
          </ul>
        </template>

        <details class="import-manual">
          <summary>{{ t('手动指定其他路径（单个插件目录或角色 md）') }}</summary>
          <label class="import-path">
            <span>{{ t('插件目录或角色文件') }}</span>
            <AppInput
              v-model="path"
              :placeholder="t('例如：~/.workbuddy/plugins/cache/experts/code-crew/1.0.0')"
              mono
              @keydown.enter="runPreviewPath"
            />
          </label>
          <div class="import-actions">
            <AppButton
              variant="secondary"
              :disabled="!path.trim() || previewing"
              @click="runPreviewPath"
            >
              {{ previewing ? t('识别中…') : t('识别并预览') }}
            </AppButton>
            <span class="import-hint">{{ t('支持 WorkBuddy 的 plugin.json + agents/*.md，也接受单个角色 md。') }}</span>
          </div>
        </details>
      </template>

      <!-- ── 明细态：逐专家决策（工具映射 / 冲突），跨包合并 ── -->
      <template v-else>
        <p class="import-summary">
          {{ t('识别到 {0} 个专家，来自 {1} 个包', [allExperts.length, previewOrder.length]) }}
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

        <div v-if="unmappedFields.length" class="import-block">
          <strong>{{ t('插件级字段未映射（不会写入）') }}</strong>
          <ul>
            <li v-for="field in unmappedFields" :key="field.field">
              <code>{{ field.field }}</code>{{ field.reason }}
            </li>
          </ul>
        </div>

        <article
          v-for="{ expert, slug } in allExperts"
          :key="expert.id"
          class="import-card"
        >
          <header>
            <div>
              <strong>{{ expert.name }}</strong>
              <span class="mono">{{ expert.id }}</span>
              <span class="import-pack-tag mono">{{ packNames[slug] ?? slug }}</span>
            </div>
            <span v-if="packTeams[slug]" class="import-badge team">{{ t('团队') }}</span>
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
            <strong>{{ t('这些工具当前内核没有：有建议的已自动采纳，其余默认忽略；可改选替代工具') }}</strong>
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
      <AppButton variant="secondary" @click="mode === 'detail' ? backToScan() : emit('close')">
        {{ mode === 'detail' ? t('返回清单') : t('取消') }}
      </AppButton>
      <AppButton
        v-if="mode === 'scan'"
        variant="primary"
        :disabled="!selectedPackages.length || scanning || previewing"
        @click="goDetail"
      >
        {{ previewing ? t('识别中…') : t('预览 {0} 个包', [selectedPackages.length]) }}
      </AppButton>
      <AppButton v-else variant="primary" :disabled="!canApply || applying" @click="applyImport">
        {{ applying ? t('导入中…') : t('导入 {0} 个专家', [importCount]) }}
      </AppButton>
    </template>
  </AppModal>
</template>

<style src="./ExpertImportDialog.css" scoped></style>
