<script setup lang="ts">
import { t } from '@/i18n'
/**
 * 连接器导入弹窗（Cordis 思想：外部配置源 → 规范候选 → 主路径落库）。
 *
 * 只有一个导入源时不值得抽象；有第二个（Cursor / Claude Desktop 的 mcp.json）
 * 时，后端加一个 parse_* 纯函数、前端零改动——候选形状（ConnectorCandidate）
 * 与入参（ConnectorInput）已经是各源归一后的规范形态。
 *
 * 导入逐项走 connectorsCreate：校验、serverName 唯一、握手全部复用手工新建
 * 那条域路径，这里不写任何「批量落库」旁路。凭据不迁移，导入后自己配。
 */
import { computed, ref, watch } from 'vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppCheckbox from '@/components/ui/AppCheckbox.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import {
  candidateToInput,
  connectorsCreate,
  connectorsImportScan,
  describeConnectorError,
  type ConnectorCandidate,
  type ConnectorImportScan,
} from '@/composables/useConnectors'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; saved: [] }>()

const scan = ref<ConnectorImportScan | null>(null)
const loading = ref(false)
const error = ref('')
/** server_name → 是否勾选（可导入项默认全选）。 */
const picked = ref<Record<string, boolean>>({})
const importing = ref(false)
/** server_name → 失败原因（成功项从清单里移除，剩下的都是没成的）。 */
const failures = ref<Record<string, string>>({})

const candidates = computed(() => scan.value?.candidates ?? [])
const importable = computed(() => candidates.value.filter((c) => !c.skip_reason && !c.conflict))
const selected = computed(() => importable.value.filter((c) => picked.value[c.server_name]))
const skippedCount = computed(() => candidates.value.length - importable.value.length)

/** 扫描根的展示文案：~ 缩写，与专家导入弹窗同一语言。 */
const rootLabel = computed(() => {
  const root = scan.value?.root ?? ''
  if (!root) return ''
  return root.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~')
})

function transportLabel(c: ConnectorCandidate): string {
  return c.transport === 'stdio' ? 'stdio' : c.transport === 'streamable-http' ? 'HTTP' : c.transport
}

function skipText(c: ConnectorCandidate): string {
  if (c.conflict) return t('本地已有同名服务标识，不能重复导入')
  switch (c.skip_reason) {
    case 'connector/import-command-missing':
      return t('源配置缺少启动命令')
    case 'connector/import-url-missing':
      return t('源配置缺少 HTTP 地址')
    case 'connector/import-url-invalid':
      return t('源配置的 HTTP 地址不合法')
    case 'connector/server-name-invalid':
      return t('服务标识清洗后为空')
    default:
      return t('无法解析为连接器配置')
  }
}

async function load() {
  loading.value = true
  error.value = ''
  failures.value = {}
  try {
    scan.value = await connectorsImportScan()
    const next: Record<string, boolean> = {}
    for (const c of scan.value.candidates) {
      if (!c.skip_reason && !c.conflict) next[c.server_name] = true
    }
    picked.value = next
  } catch (e) {
    error.value = describeConnectorError(e, t('读取导入源失败'))
  } finally {
    loading.value = false
  }
}

/** 逐项走 connectorsCreate（同一条域路径）；失败项留下原因，成功项移出清单。 */
async function applyImport() {
  importing.value = true
  error.value = ''
  const done: string[] = []
  for (const c of selected.value) {
    try {
      await connectorsCreate(candidateToInput(c))
      done.push(c.server_name)
    } catch (e) {
      failures.value = { ...failures.value, [c.server_name]: describeConnectorError(e, t('导入失败')) }
    }
  }
  if (done.length) {
    const names = new Set(done)
    scan.value = {
      ...(scan.value as ConnectorImportScan),
      candidates: candidates.value.filter((c) => !names.has(c.server_name)),
    }
    for (const k of done) delete picked.value[k]
    emit('saved')
  }
  if (!importable.value.length) {
    // 可导入项已全部处理完（成功移出 / 本就不可导入）：留在弹窗里没有任何下一步，自动收。
    importing.value = false
    emit('close')
    return
  }
  importing.value = false
}

function close() {
  emit('close')
}

watch(
  () => props.open,
  (v) => {
    if (v) void load()
  },
)
</script>

<template>
  <AppModal :open="open" :title="t('从 WorkBuddy 导入连接器')" size="lg" @close="close">
    <p v-if="rootLabel" class="ci-root">
      <AppIcon name="folder" :size="13" />
      <span>{{ t('导入源') }}</span>
      <code>{{ rootLabel }}</code>
    </p>
    <p v-if="loading" class="ci-hint">{{ t('正在读取…') }}</p>
    <p v-else-if="error" class="ci-error">{{ error }}</p>
    <template v-else-if="!candidates.length">
      <p class="ci-hint">{{ t('这台机器的 WorkBuddy 里没有配置任何 MCP 服务。') }}</p>
    </template>
    <template v-else>
      <p class="ci-hint">
        {{
          t('共 {0} 项，可导入 {1} 项（其余 {2} 项不可导入）。凭据不会带过来，导入后在编辑器里自己配。', [
            candidates.length,
            importable.length,
            skippedCount,
          ])
        }}
      </p>
      <ul class="ci-list">
        <li v-for="c in candidates" :key="c.server_name" class="ci-item" :class="{ off: !!c.skip_reason || c.conflict }">
          <AppCheckbox
            v-if="!c.skip_reason && !c.conflict"
            :model-value="picked[c.server_name] === true"
            :label="c.title"
            @update:model-value="picked[c.server_name] = $event"
          />
          <span v-else class="ci-title">{{ c.title }}</span>
          <span class="ci-meta">
            <code>{{ c.server_name }}</code>
            <span>{{ transportLabel(c) }}</span>
            <span v-if="!c.source_enabled" class="ci-src-off">{{ t('源侧已停用') }}</span>
          </span>
          <span v-if="c.skip_reason || c.conflict" class="ci-skip">{{ skipText(c) }}</span>
          <span v-else-if="failures[c.server_name]" class="ci-fail">{{ failures[c.server_name] }}</span>
        </li>
      </ul>
    </template>

    <template #footer>
      <AppButton variant="secondary" :disabled="importing" @click="close">{{ t('关闭') }}</AppButton>
      <AppButton variant="secondary" :disabled="loading || importing" @click="load">{{ t('重新扫描') }}</AppButton>
      <AppButton
        variant="primary"
        :disabled="loading || importing || !selected.length"
        @click="applyImport"
      >
        {{ importing ? t('导入中…') : t('导入所选（{0}）', [selected.length]) }}
      </AppButton>
    </template>
  </AppModal>
</template>

<style src="./ConnectorImportDialog.css" scoped></style>
