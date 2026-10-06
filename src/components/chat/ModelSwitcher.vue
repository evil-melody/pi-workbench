<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { invoke } from '@tauri-apps/api/core'
import AppSelect, { type SelectOption } from '@/components/ui/AppSelect.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import { isTauriRuntime } from '@/composables/useRuntime'

/**
 * 模型选择器。
 *
 * 数据来自应用设置（`app-settings.json` 的 `models` 列表），与设置页共用同一份真源：
 * 这里改的是 `default_model_id`，写回后**重启内核**，新模型才会在 Pi 进程里生效
 * （Pi 只在 spawn 时读取 provider/model，热改不生效）。
 */
export interface ModelOption {
  id: string
  name: string
  provider: string
  model: string
  enabled: boolean
}

const props = withDefaults(defineProps<{ width?: string; compact?: boolean }>(), {
  width: '150px',
  compact: false,
})

const emit = defineEmits<{ change: [id: string] }>()

const router = useRouter()
const models = ref<ModelOption[]>([])
const defaultId = ref('')
const loading = ref(false)
const note = ref('')
const inTauri = isTauriRuntime()

const options = computed<SelectOption[]>(() =>
  models.value
    .filter((m) => m.enabled)
    .map((m) => ({ value: m.id, label: m.name, hint: `${m.provider} · ${m.model}` })),
)

/** 没有任何可用模型时，选择器退化成「去设置页配置」的入口，而不是一个空下拉。 */
const needsSetup = computed(() => inTauri && !loading.value && !options.value.length)
async function load() {
  if (!inTauri) return
  loading.value = true
  try {
    const s = await invoke<{ models?: ModelOption[]; default_model_id?: string | null }>('settings_load')
    models.value = s?.models ?? []
    defaultId.value = s?.default_model_id ?? models.value.find((m) => m.enabled)?.id ?? ''
  } catch (e) {
    note.value = `读取模型配置失败：${String(e)}`
  } finally {
    loading.value = false
  }
}

async function pick(id: string) {
  if (!id || id === defaultId.value) return
  const prev = defaultId.value
  defaultId.value = id
  note.value = ''
  try {
    // 读回整份设置再改一个字段：避免把主题 / 语言等其它配置写丢。
    const s = await invoke<Record<string, unknown>>('settings_load')
    await invoke('settings_save', { settings: { ...s, default_model_id: id } })
    // 内核只在启动时读模型：不重启就只是「换了个标签」，不会真的换模型。
    await invoke('pi_restart').catch(() => {})
    emit('change', id)
  } catch (e) {
    defaultId.value = prev
    note.value = `切换模型失败：${String(e)}`
  }
}

onMounted(load)

defineExpose({ reload: load })
</script>

<template>
  <div class="model-switcher" :class="{ compact }">
    <button
      v-if="needsSetup"
      type="button"
      class="ms-setup"
      :title="'还没有可用的模型配置，去设置页添加'"
      @click="router.push('/settings')"
    >
      <AppIcon name="settings" :size="13" />
      <span>配置模型</span>
    </button>

    <template v-else>
      <!--
        触发器已经显示模型名，旁边再打印一遍 `provider · model` 是纯噪音
        （模型名常常就是 model 字段本身）。明细留在下拉项与 title 里。
      -->
      <AppSelect
        :model-value="defaultId"
        :options="options"
        :disabled="!inTauri || loading"
        :placeholder="inTauri ? (loading ? '读取中…' : '选择模型') : '浏览器预览无模型'"
        :width="width"
        @update:model-value="pick"
      />
    </template>

    <p v-if="note" class="ms-note">{{ note }}</p>
  </div>
</template>

<style src="./ModelSwitcher.css" scoped></style>
