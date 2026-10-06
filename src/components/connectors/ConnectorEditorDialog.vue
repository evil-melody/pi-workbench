<script setup lang="ts">
/**
 * 连接器新建 / 编辑弹窗。
 *
 * 只写令牌字段（`authorization_token`）：读接口从不回传，留空即「不改动凭据」。
 * 启动参数用「一行一个」编辑，落盘时转成数组，比一个逗号分隔的文本框好校对。
 */
import { computed, ref, watch } from 'vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppTextarea from '@/components/ui/AppTextarea.vue'
import AppSelect, { type SelectOption } from '@/components/ui/AppSelect.vue'
import AppModal from '@/components/ui/AppModal.vue'
import {
  connectorsConfig,
  connectorsCreate,
  connectorsUpdate,
  describeConnectorError,
  emptyInput,
  validateServerName,
  type ConnectorInput,
  type ConnectorTransport,
} from '@/composables/useConnectors'

const props = defineProps<{ open: boolean; connectorId: string | null }>()
const emit = defineEmits<{ close: []; saved: [] }>()

const TRANSPORT_OPTIONS: SelectOption[] = [
  { value: 'stdio', label: 'stdio 子进程', hint: '本地命令，会真的握手拿工具' },
  { value: 'streamable-http', label: 'Streamable HTTP', hint: '远程 HTTP 端点' },
]

const form = ref<ConnectorInput>(emptyInput())
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const authConfigured = ref(false)

const isEdit = computed(() => !!props.connectorId)
const serverNameError = computed(() => validateServerName(form.value.server_name))
const titleError = computed(() => (form.value.title.trim() ? null : '名称不能为空'))

async function fillForm() {
  error.value = ''
  if (!props.connectorId) {
    form.value = emptyInput()
    authConfigured.value = false
    return
  }
  loading.value = true
  try {
    const cfg = await connectorsConfig(props.connectorId)
    form.value = {
      title: cfg.title,
      description: cfg.description,
      server_name: cfg.server_name,
      transport: cfg.transport,
      command: cfg.command ?? '',
      args: cfg.args ?? [],
      url: cfg.url ?? '',
      authorization_token: '',
    }
    authConfigured.value = cfg.authorization_configured
  } catch (e) {
    error.value = describeConnectorError(e, '读取连接器配置失败')
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.open, props.connectorId] as const,
  () => {
    if (props.open) void fillForm()
  },
  { immediate: true },
)

function argsToText(list: string[] | undefined) {
  return (list ?? []).join('\n')
}

function textToArgs(text: string) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function payload(): ConnectorInput {
  const f = form.value
  const stdio = f.transport === 'stdio'
  return {
    title: f.title.trim(),
    description: f.description.trim(),
    server_name: f.server_name.trim(),
    transport: f.transport,
    // 非当前传输的字段一律置空，避免把上一次残留的值提交上去。
    command: stdio ? f.command.trim() : '',
    args: stdio ? textToArgs(f.args.join('\n')) : [],
    url: stdio ? '' : f.url.trim(),
    authorization_token: f.authorization_token.trim(),
  }
}

async function save() {
  if (titleError.value || serverNameError.value) {
    error.value = '请先修正表单中的错误'
    return
  }
  saving.value = true
  error.value = ''
  try {
    if (props.connectorId) {
      await connectorsUpdate(props.connectorId, payload())
    } else {
      await connectorsCreate(payload())
    }
    emit('saved')
    emit('close')
  } catch (e) {
    error.value = describeConnectorError(e, '保存失败')
  } finally {
    saving.value = false
  }
}

function switchTransport(value: string) {
  form.value.transport = value as ConnectorTransport
}

function close() {
  emit('close')
}
</script>

<template>
  <AppModal :open="open" :title="isEdit ? '编辑连接器' : '新建连接器'" size="md" @close="close">
    <div class="ce-form">
      <div class="ce-row">
        <label>
          <span class="ce-label">名称</span>
          <AppInput v-model="form.title" placeholder="GitHub" />
        </label>
        <small v-if="titleError" class="ce-err">{{ titleError }}</small>
      </div>

      <label>
        <span class="ce-label">描述</span>
        <AppTextarea
          :model-value="form.description"
          :rows="2"
          placeholder="这个连接器提供哪些能力"
          @update:model-value="form.description = $event"
        />
      </label>

      <div class="ce-row">
        <label>
          <span class="ce-label">服务标识（serverName）</span>
          <AppInput v-model="form.server_name" mono placeholder="github" />
        </label>
        <small v-if="serverNameError" class="ce-err">{{ serverNameError }}</small>
        <small v-else class="ce-hint">
          决定工具命名空间 <code>mcp__&lt;标识&gt;__&lt;工具&gt;</code>，全局唯一
        </small>
      </div>

      <label>
        <span class="ce-label">传输协议</span>
        <AppSelect
          :model-value="form.transport"
          :options="TRANSPORT_OPTIONS"
          @update:model-value="switchTransport"
        />
      </label>

      <label v-if="form.transport === 'stdio'">
        <span class="ce-label">启动命令</span>
        <AppInput v-model="form.command" mono placeholder="npx -y @modelcontextprotocol/server-github" />
      </label>

      <label v-if="form.transport === 'stdio'">
        <span class="ce-label">启动参数（一行一个）</span>
        <AppTextarea
          :model-value="argsToText(form.args)"
          :rows="3"
          mono
          placeholder="--token=xxx"
          @update:model-value="form.args = textToArgs($event)"
        />
      </label>

      <label v-else>
        <span class="ce-label">HTTP 地址</span>
        <AppInput v-model="form.url" mono placeholder="https://mcp.example.com/mcp" />
      </label>

      <label>
        <span class="ce-label">
          凭据令牌
          <em v-if="isEdit && authConfigured" class="ce-set">已配置，留空表示不修改</em>
        </span>
        <AppInput
          v-model="form.authorization_token"
          type="password"
          placeholder="只写字段，保存后不会回显"
        />
      </label>

      <p v-if="error" class="ce-error">{{ error }}</p>
      <p v-if="loading" class="ce-hint">正在读取配置…</p>
    </div>

    <template #footer>
      <button class="ce-btn" :disabled="saving" @click="close">取消</button>
      <button class="ce-btn primary" :disabled="saving || loading" @click="save">
        {{ saving ? '保存中…' : '保存' }}
      </button>
    </template>
  </AppModal>
</template>

<style src="./ConnectorEditorDialog.css" scoped></style>
