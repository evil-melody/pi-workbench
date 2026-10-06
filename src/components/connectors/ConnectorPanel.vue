<script setup lang="ts">
/**
 * 连接器管理面板 —— 列表 / 详情 / 启停 / 删除链路。
 *
 * 上半部分是实例管理（定义层的 CRUD），
 * 下半部分是「本会话使用」：会话选择不是记一下就算，
 * 要显式点「应用到内核白名单」，作用域才会真的落到 Pi 的 defaultTools 上。
 */
import { computed, onMounted, ref, watch } from 'vue'
import AppIcon from '@/components/ui/AppIcon.vue'
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
  STATE_TEXT,
  TRANSPORT_TEXT,
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
    error.value = describeConnectorError(e, '读取连接器失败')
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
    emit('notice', `「${next.title}」已${next.enabled ? '启用' : '停用'}`)
  } catch (e) {
    emit('error', describeConnectorError(e, '启停失败'))
  }
}

async function removeConnector(c: ConnectorSummary) {
  pendingDelete.value = null
  deleting.value = true
  try {
    await connectorsRemove(c.id)
    if (activeId.value === c.id) activeId.value = list.value.find((x) => x.id !== c.id)?.id ?? null
    emit('notice', `已删除「${c.title}」，相关会话选择已同步移除`)
    await reload()
  } catch (e) {
    emit('error', describeConnectorError(e, '删除失败'))
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
    emit('error', describeConnectorError(e, '选择失败'))
  }
}

async function applyScope() {
  applying.value = true
  try {
    scope.value = await connectorsApplyScope(props.sessionId)
    emit('notice', `已把 ${scope.value.length} 个工具注入内核白名单`)
  } catch (e) {
    emit('error', describeConnectorError(e, '应用作用域失败'))
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
    emit('error', describeConnectorError(e, '修改白名单失败'))
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
      <AppInput v-model="keyword" placeholder="搜索连接器（名称 / 服务标识）" />
      <span class="cp-stat">
        共 {{ list.length }} 个，启用 {{ list.filter((c) => c.enabled).length }}
      </span>
      <button class="cp-btn" :disabled="loading" @click="reload">刷新</button>
      <button class="cp-btn primary" @click="openCreate">+ 新建连接器</button>
    </div>

    <p v-if="error" class="cp-error">{{ error }}</p>

    <div class="cp-body">
      <aside class="cp-list">
        <p v-if="loading && !list.length" class="cp-hint">正在读取连接器…</p>
        <p v-else-if="!filtered.length" class="cp-hint">
          {{ keyword ? '没有匹配的连接器' : '还没有连接器，点右上「新建连接器」添加一个' }}
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
            <span class="cp-badge" :data-state="c.state">{{ STATE_TEXT[c.state] }}</span>
          </div>
          <span class="cp-item-sub">
            <code>{{ c.server_name }}</code> · {{ TRANSPORT_TEXT[c.transport] }} ·
            {{ c.tool_count }} 个工具
          </span>
          <div class="cp-item-actions" @click.stop>
            <button
              class="cp-mini"
              :title="c.enabled ? '停用' : '启用'"
              @click="toggleEnabled(c)"
            >
              {{ c.enabled ? '停用' : '启用' }}
            </button>
            <button
              v-if="pendingDelete === c.id"
              class="cp-mini danger"
              :disabled="deleting"
              @click="removeConnector(c)"
            >
              确认删除
            </button>
            <button
              v-else
              class="cp-mini danger"
              title="删除连接器"
              @click="pendingDelete = c.id"
            >
              <AppIcon name="trash" :size="13" />
            </button>
          </div>
        </div>
      </aside>

      <section class="cp-detail">
        <template v-if="activeItem">
          <header class="cp-detail-head">
            <div>
              <h4>{{ activeItem.title }}</h4>
              <span class="cp-muted">{{ activeItem.description || '（暂无描述）' }}</span>
            </div>
            <div class="cp-detail-actions">
              <button class="cp-btn" @click="openEdit(activeItem.id)">编辑</button>
            </div>
          </header>

          <dl class="cp-facts">
            <div><dt>服务标识</dt><dd><code>{{ activeItem.server_name }}</code></dd></div>
            <div><dt>传输</dt><dd>{{ TRANSPORT_TEXT[activeItem.transport] }}</dd></div>
            <div>
              <dt>状态</dt>
              <dd>
                <span class="cp-badge" :data-state="activeItem.state">
                  {{ STATE_TEXT[activeItem.state] }}
                </span>
              </dd>
            </div>
            <div>
              <dt>本会话</dt>
              <dd>{{ selection.includes(activeItem.id) ? '已选中' : '未选中' }}</dd>
            </div>
          </dl>

          <p v-if="activeItem.diagnostic" class="cp-diag">诊断：{{ activeItem.diagnostic }}</p>

          <div v-if="activeItem.tool_names.length" class="cp-tools">
            <p class="cp-tools-head">已发现的工具（{{ activeItem.tool_names.length }}）</p>
            <ul>
              <li v-for="t in activeItem.tool_names" :key="t"><code>{{ t }}</code></li>
            </ul>
          </div>
          <p v-else class="cp-hint">这个连接器还没有暴露任何工具。</p>
        </template>
        <p v-else class="cp-hint">在左侧选择一个连接器查看详情。</p>
      </section>
    </div>

    <div v-if="showSession" class="cp-session">
      <div class="cp-session-head">
        <strong>本会话使用</strong>
        <span class="cp-muted">
          选中哪些连接器由这个会话决定；点「应用到内核白名单」后才会真的注入。
        </span>
        <button class="cp-btn primary" :disabled="applying" @click="applyScope">
          {{ applying ? '应用中…' : '应用到内核白名单' }}
        </button>
      </div>

      <div v-if="!!list.length" class="cp-session-pick">
        <button
          v-for="c in list"
          :key="c.id"
          class="cp-chip"
          :class="{ on: selection.includes(c.id), off: !c.enabled }"
          :disabled="!c.enabled"
          :title="c.enabled ? '' : '已停用的连接器不能被会话选中'"
          @click="toggleSelection(c)"
        >
          {{ c.title }}
        </button>
      </div>
      <p v-else class="cp-hint">还没有连接器可选。</p>

      <div v-if="scope.length" class="cp-scope">
        <p class="cp-tools-head">注入白名单（{{ scope.length }}）</p>
        <div class="cp-scope-list">
          <code v-for="t in scope" :key="t">{{ t }}</code>
        </div>
      </div>

      <div v-if="orphans.length" class="cp-orphans">
        <p class="cp-tools-head">
          其他 MCP 工具（不属于任何连接器，勾选后直接写内核白名单）
        </p>
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
