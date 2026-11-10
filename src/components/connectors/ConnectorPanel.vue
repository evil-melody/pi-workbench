<script setup lang="ts">
import { t } from '@/i18n'
/**
 * 连接器管理面板 —— 列表 / 详情 / 启停 / 删除链路。
 *
 * 上半部分是实例管理（定义层的 CRUD），
 * 下半部分是「本会话使用」：会话选择不是记一下就算，
 * 要显式点「应用到内核白名单」，作用域才会真的落到 Pi 的 defaultTools 上。
 */
import { computed, onMounted, ref, watch } from 'vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppCheckbox from '@/components/ui/AppCheckbox.vue'
import ConnectorEditorDialog from './ConnectorEditorDialog.vue'
import { mcpList } from '@/composables/useMcp'
import { toolsActivate, toolsList } from '@/composables/useTools'
import { parseToolName, parseToolDescription } from '@/utils/mcpTools'
import {
  connectorsList,
  connectorsRemove,
  connectorsSelection,
  connectorsSetSelection,
  connectorsApplyScope,
  connectorsSetEnabled,
  describeConnectorError,
  stateText,
  transportText,
  type ConnectorState,
  type ConnectorSummary,
} from '@/composables/useConnectors'

const props = withDefaults(
  defineProps<{ sessionId?: string; showSession?: boolean }>(),
  { sessionId: 'pi-workbench:default', showSession: true },
)

const emit = defineEmits<{ notice: [string]; error: [string]; count: [number] }>()

const list = ref<ConnectorSummary[]>([])
const keyword = ref('')
const activeId = ref<string | null>(null)
const loading = ref(false)
const error = ref('')
const editorOpen = ref(false)
const editorId = ref<string | null>(null)
const pendingDelete = ref<string | null>(null)
const deleting = ref(false)

const selection = ref<string[]>([])
const activeTools = ref<string[]>([])
const scope = ref<string[]>([])
const orphans = ref<Array<{ key: string; server: string; name: string; description: string }>>([])
const applying = ref(false)

const filtered = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  if (!k) return list.value
  return list.value.filter(
    (c) =>
      c.title.toLowerCase().includes(k) ||
      c.server_name.toLowerCase().includes(k) ||
      c.description.toLowerCase().includes(k),
  )
})

const activeItem = computed(() => list.value.find((c) => c.id === activeId.value) ?? null)

/**
 * 勾选态按「完整工具名」判定：写入白名单的是 `mcp__<服务>__<工具>`，不是原始工具名。
 * 只按 name 判会让同名工具在不同 server 间串味。
 */
function fqnOf(orphan: { server: string; name: string }) {
  return `mcp__${orphan.server}__${orphan.name}`
}

function isOrphanChecked(orphan: { server: string; name: string }) {
  return activeTools.value.includes(fqnOf(orphan))
}

async function reload() {
  loading.value = true
  error.value = ''
  try {
    list.value = await connectorsList()
    if (activeId.value && !list.value.some((c) => c.id === activeId.value)) {
      activeId.value = list.value[0]?.id ?? null
    }
    if (!activeId.value) activeId.value = list.value[0]?.id ?? null
    await loadSession()
    emit('count', list.value.length)
  } catch (e) {
    error.value = describeConnectorError(e, t('读取连接器失败'))
  } finally {
    loading.value = false
  }
}

async function loadSession() {
  const sid = props.sessionId
  try {
    selection.value = await connectorsSelection(sid)
  } catch {
    selection.value = []
  }
  try {
    const ts = await toolsList().catch(() => ({ active: [] as string[] }))
    activeTools.value = ts.active
  } catch {
    activeTools.value = []
  }
  refreshOrphans()
}

/** 孤儿工具清单来自 mcp_list：这些 server 没有对应的连接器定义。 */
async function refreshOrphans() {
  const known = new Set(list.value.map((c) => c.server_name))
  try {
    const raw = (await mcpList()) as Array<{ name?: unknown; tools?: unknown }>
    const picked = raw.flatMap((srv) => {
      const server = String(srv.name ?? '')
      const tools = Array.isArray(srv.tools) ? srv.tools : []
      return tools.map((t: unknown, i: number) => ({
        key: `${server}:${parseToolName(t)}:${i}`,
        server,
        name: parseToolName(t),
        description: parseToolDescription(t),
      }))
    })
    orphans.value = picked.filter((t) => t.server && !known.has(t.server))
  } catch {
    orphans.value = []
  }
}

function selectConnector(id: string) {
  activeId.value = id
}

function openCreate() {
  editorId.value = null
  editorOpen.value = true
}

function openEdit(id: string) {
  editorId.value = id
  editorOpen.value = true
}

function onSaved() {
  editorOpen.value = false
  void reload()
}

async function toggleEnabled(c: ConnectorSummary) {
  try {
    const next = await connectorsSetEnabled(c.id, !c.enabled)
    const idx = list.value.findIndex((x) => x.id === c.id)
    if (idx >= 0) list.value[idx] = next
    if (!next.enabled) {
      selection.value = selection.value.filter((id) => id !== c.id)
    }
    emit('notice', t('「{0}」已{1}', [next.title, next.enabled ? t('启用') : t('停用')]))
  } catch (e) {
    emit('error', describeConnectorError(e, t('启停失败')))
  }
}

async function removeConnector(c: ConnectorSummary) {
  pendingDelete.value = null
  deleting.value = true
  try {
    await connectorsRemove(c.id)
    if (activeId.value === c.id) activeId.value = list.value.find((x) => x.id !== c.id)?.id ?? null
    emit('notice', t('已删除「{0}」，相关会话选择已同步移除', [c.title]))
    await reload()
  } catch (e) {
    emit('error', describeConnectorError(e, t('删除失败')))
  } finally {
    deleting.value = false
  }
}

async function toggleSelection(c: ConnectorSummary) {
  const next = selection.value.includes(c.id)
    ? selection.value.filter((id) => id !== c.id)
    : [...selection.value, c.id]
  try {
    selection.value = await connectorsSetSelection(props.sessionId, next)
  } catch (e) {
    emit('error', describeConnectorError(e, t('选择失败')))
  }
}

async function applyScope() {
  applying.value = true
  try {
    scope.value = await connectorsApplyScope(props.sessionId)
    emit('notice', t('已把 {0} 个工具注入内核白名单', [scope.value.length]))
  } catch (e) {
    emit('error', describeConnectorError(e, t('应用作用域失败')))
  } finally {
    applying.value = false
  }
}

async function toggleOrphan(fqn: string, enabled: boolean) {
  try {
    const ts = await toolsActivate([fqn], enabled)
    activeTools.value = ts.active
    await loadSession()
  } catch (e) {
    emit('error', describeConnectorError(e, t('修改白名单失败')))
  }
}

watch(
  () => props.sessionId,
  () => void loadSession(),
)

onMounted(reload)
</script>

<template>
  <div class="cp">
    <div class="cp-toolbar">
      <AppInput v-model="keyword" :placeholder="t('搜索连接器（名称 / 服务标识）')" />
      <span class="cp-stat">{{ t('共 {0} 个，启用 {1}', [list.length, list.filter((c) => c.enabled).length]) }}
      </span>
      <AppButton variant="secondary" class="cp-btn" :disabled="loading" @click="reload">{{ t('刷新') }}</AppButton>
      <AppButton variant="primary" class="cp-btn primary" @click="openCreate">{{ t('+ 新建连接器') }}</AppButton>
    </div>

    <p v-if="error" class="cp-error">{{ error }}</p>

    <div class="cp-body">
      <aside class="cp-list">
        <p v-if="loading && !list.length" class="cp-hint">{{ t('正在读取连接器…') }}</p>
        <p v-else-if="!filtered.length" class="cp-hint">
          {{ keyword ? t('没有匹配的连接器') : t('还没有连接器，点右上「新建连接器」添加一个') }}
        </p>
        <div
          v-for="c in filtered"
          :key="c.id"
          class="cp-item"
          :class="{ on: c.id === activeId }"
          @click="selectConnector(c.id)"
        >
          <div class="cp-item-top">
            <strong>{{ c.title }}</strong>
            <span class="cp-badge" :data-state="c.state">{{ stateText(c.state) }}</span>
          </div>
          <span class="cp-item-sub">
            <code>{{ c.server_name }}</code>{{ t('· {0} · {1} 个工具', [transportText(c.transport), c.tool_count]) }}</span>
          <div class="cp-item-actions" @click.stop>
            <AppButton
              variant="text"
              size="sm"
              class="cp-mini"
              :title="c.enabled ? t('停用') : t('启用')"
              @click="toggleEnabled(c)"
            >
              {{ c.enabled ? t('停用') : t('启用') }}
            </AppButton>
            <AppButton
              v-if="pendingDelete === c.id"
              variant="danger"
              size="sm"
              class="cp-mini danger"
              :disabled="deleting"
              @click="removeConnector(c)"
            >{{ t('确认删除') }}</AppButton>
            <AppButton
              v-else
              variant="icon"
              size="sm"
              class="cp-mini danger"
              :title="t('删除连接器')"
              :aria-label="t('删除连接器')"
              @click="pendingDelete = c.id"
            >
              <AppIcon name="trash" :size="13" />
            </AppButton>
          </div>
        </div>
      </aside>

      <section class="cp-detail">
        <template v-if="activeItem">
          <header class="cp-detail-head">
            <div>
              <h4>{{ activeItem.title }}</h4>
              <span class="cp-muted">{{ activeItem.description || t('（暂无描述）') }}</span>
            </div>
            <div class="cp-detail-actions">
              <AppButton variant="secondary" class="cp-btn" @click="openEdit(activeItem.id)">{{ t('编辑') }}</AppButton>
            </div>
          </header>

          <dl class="cp-facts">
            <div><dt>{{ t('服务标识') }}</dt><dd><code>{{ activeItem.server_name }}</code></dd></div>
            <div><dt>{{ t('传输') }}</dt><dd>{{ transportText(activeItem.transport) }}</dd></div>
            <div>
              <dt>{{ t('状态') }}</dt>
              <dd>
                <span class="cp-badge" :data-state="activeItem.state">
                  {{ stateText(activeItem.state) }}
                </span>
              </dd>
            </div>
            <div>
              <dt>{{ t('本会话') }}</dt>
              <dd>{{ selection.includes(activeItem.id) ? t('已选中') : t('未选中') }}</dd>
            </div>
          </dl>

          <p v-if="activeItem.diagnostic" class="cp-diag">{{ t('诊断：{0}', [activeItem.diagnostic]) }}</p>

          <div v-if="activeItem.tool_names.length" class="cp-tools">
            <p class="cp-tools-head">{{ t('已发现的工具（{0}）', [activeItem.tool_names.length]) }}</p>
            <ul>
              <li v-for="t in activeItem.tool_names" :key="t"><code>{{ t }}</code></li>
            </ul>
          </div>
          <p v-else class="cp-hint">{{ t('这个连接器还没有暴露任何工具。') }}</p>
        </template>
        <p v-else class="cp-hint">{{ t('在左侧选择一个连接器查看详情。') }}</p>
      </section>
    </div>

    <div v-if="showSession" class="cp-session">
      <div class="cp-session-head">
        <strong>{{ t('本会话使用') }}</strong>
        <span class="cp-muted">{{ t('选中哪些连接器由这个会话决定；点「应用到内核白名单」后才会真的注入。') }}</span>
        <AppButton variant="primary" class="cp-btn primary" :disabled="applying" @click="applyScope">
          {{ applying ? t('应用中…') : t('应用到内核白名单') }}
        </AppButton>
      </div>

      <div v-if="!!list.length" class="cp-session-pick">
        <AppButton
          v-for="c in list"
          :key="c.id"
          variant="chip"
          class="cp-chip"
          :class="{ on: selection.includes(c.id), off: !c.enabled }"
          :aria-pressed="selection.includes(c.id)"
          :disabled="!c.enabled"
          :title="c.enabled ? '' : t('已停用的连接器不能被会话选中')"
          @click="toggleSelection(c)"
        >
          {{ c.title }}
        </AppButton>
      </div>
      <p v-else class="cp-hint">{{ t('还没有连接器可选。') }}</p>

      <div v-if="scope.length" class="cp-scope">
        <p class="cp-tools-head">{{ t('注入白名单（{0}）', [scope.length]) }}</p>
        <div class="cp-scope-list">
          <code v-for="t in scope" :key="t">{{ t }}</code>
        </div>
      </div>

      <div v-if="orphans.length" class="cp-orphans">
        <p class="cp-tools-head">{{ t('其他 MCP 工具（不属于任何连接器，勾选后直接写内核白名单）') }}</p>
        <label v-for="t in orphans" :key="t.key" class="cp-orphan">
          <AppCheckbox
            :model-value="isOrphanChecked(t)"
            :label="t.name"
            @update:model-value="toggleOrphan(fqnOf(t), $event)"
          />
          <span class="cp-muted">{{ t.description }}</span>
        </label>
      </div>
    </div>

    <ConnectorEditorDialog
      :open="editorOpen"
      :connector-id="editorId"
      @close="editorOpen = false"
      @saved="onSaved"
    />
  </div>
</template>

<style src="./ConnectorPanel.css" scoped></style>
