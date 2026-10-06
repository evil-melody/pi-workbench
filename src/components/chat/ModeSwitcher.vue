<script setup lang="ts">
import AppIcon from '@/components/ui/AppIcon.vue'
import AppSelect, { type SelectOption } from '@/components/ui/AppSelect.vue'

defineProps<{ modelValue: string; width?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

/**
 * 三档思考预算。首页 Hero 与对话页头部共用同一份定义，
 * 避免「选完项目后模式选择器消失」和两处选项各写一遍。
 */
const options: SelectOption[] = [
  { value: '快速', label: '快速', hint: '低思考预算，响应最快' },
  { value: '标准', label: '标准', hint: '默认，速度与质量平衡' },
  { value: '深度', label: '深度', hint: '高思考预算，慢而稳' },
]

function onPick(v: string) {
  emit('update:modelValue', v)
}
</script>

<template>
  <div class="mode-switcher" title="思考深度：决定内核每轮投入的思考预算">
    <AppIcon name="zap" :size="13" class="mode-icon" />
    <AppSelect
      :model-value="modelValue"
      :options="options"
      :width="width ?? '72px'"
      @update:model-value="onPick"
    />
  </div>
</template>

<style src="./ModeSwitcher.css" scoped></style>