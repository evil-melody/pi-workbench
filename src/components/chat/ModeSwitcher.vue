<script setup lang="ts">
import { t } from '@/i18n'
import { computed } from 'vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppSelect, { type SelectOption } from '@/components/ui/AppSelect.vue'

defineProps<{ modelValue: string; width?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

/**
 * 三档思考预算。首页 Hero 与对话页头部共用同一份定义。
 * value 固定为内核 level，label 跟随当前语言，切语言不丢选择。
 */
const options = computed<SelectOption[]>(() => [
  { value: 'low', label: t('快速'), hint: t('低思考预算，响应最快') },
  { value: 'medium', label: t('标准'), hint: t('默认，速度与质量平衡') },
  { value: 'high', label: t('深度'), hint: t('高思考预算，慢而稳') },
])

function onPick(v: string) {
  emit('update:modelValue', v)
}
</script>

<template>
  <div class="mode-switcher" :title="t('思考深度：决定内核每轮投入的思考预算')">
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