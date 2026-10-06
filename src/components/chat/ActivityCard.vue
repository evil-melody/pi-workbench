<script setup lang="ts">
import { ref } from 'vue'
import AppIcon from '@/components/ui/AppIcon.vue'

const KEY = 'pi-workbench:activity-dismissed'
const dismissed = ref(localStorage.getItem(KEY) === '1')

function dismiss() {
  dismissed.value = true
  localStorage.setItem(KEY, '1')
}

function reset() {
  localStorage.removeItem(KEY)
  dismissed.value = false
}
</script>

<template>
  <div v-if="!dismissed" class="activity-card">
    <div class="activity-content">
      <div class="activity-title">
        <span class="activity-dot" />
        <span>活动</span>
      </div>
      <p class="activity-text">加入 Pi Workbench 早期体验计划，解锁多模态与 agent 工作流。</p>
      <button class="activity-link" @click="reset">
        <span>查看详情</span>
        <AppIcon name="arrow-right" :size="12" />
      </button>
    </div>
    <button class="activity-close" aria-label="关闭" @click="dismiss">
      <AppIcon name="x" :size="14" />
    </button>
  </div>
</template>

<style src="./ActivityCard.css" scoped></style>
