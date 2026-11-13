<script setup lang="ts">
import { t } from '@/i18n'
import { computed } from 'vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import { activityMessage, type ActivityState } from '@/composables/useActivity'

/**
 * F10：composer 这一行只承担「本轮在做什么」。
 * 中断动作已并入发送键的位置（运行中该位置就是停止键），这里不再重复第二个按钮。
 */
const props = defineProps<{
  state: ActivityState
  running: boolean
}>()

const message = computed(() => activityMessage(props.state))
const phaseClass = computed(() => `phase-${props.state.phase}`)
</script>

<template>
  <div class="composer-status" :class="[phaseClass, { running }]">
    <template v-if="running">
      <span class="spinner" aria-hidden="true" />
      <span class="status-main">{{ message }}</span>
    </template>

    <span v-else class="hint">
      <AppIcon name="corner-down-left" :size="11" />{{ t('Enter 发送 · Shift+Enter 换行') }}</span>
  </div>
</template>

<style src="./ComposerStatus.css" scoped></style>
