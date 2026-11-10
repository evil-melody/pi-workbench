<script setup lang="ts">
import { t } from '@/i18n'
import { computed } from 'vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppButton from '@/components/ui/AppButton.vue'
import { activityMessage, type ActivityState } from '@/composables/useActivity'

/**
 * F10：composer 这一行只承担「本轮在做什么 / 能不能中断」。
 * 会话统计与代码库索引状态已迁到右侧轨迹面板（ActivityPanel）——
 * 输入框下方只留 附件 / steer / 中断 / 发送 四个控件的位置。
 */
const props = defineProps<{
  state: ActivityState
  running: boolean
}>()
const emit = defineEmits<{ interrupt: [] }>()

const message = computed(() => activityMessage(props.state))
const phaseClass = computed(() => `phase-${props.state.phase}`)
</script>

<template>
  <div class="composer-status" :class="[phaseClass, { running }]">
    <template v-if="running">
      <span class="spinner" aria-hidden="true" />
      <span class="status-main">{{ message }}</span>
      <AppButton
        variant="danger"
        class="abort"
        :title="t('中断本轮')"
        @click="emit('interrupt')"
      >
        <AppIcon name="stop" :size="11" />
        <span>{{ t('中断') }}</span>
      </AppButton>
    </template>

    <span v-else class="hint">
      <AppIcon name="corner-down-left" :size="11" />{{ t('Enter 发送 · Shift+Enter 换行') }}</span>
  </div>
</template>

<style src="./ComposerStatus.css" scoped></style>
