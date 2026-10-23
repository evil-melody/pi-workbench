<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import { useApproval } from '@/composables/useApproval'

/**
 * B1 硬审批横幅：内核扩展拦截到风险工具调用时，等待用户批准。
 * 非模态条（不挡聊天流），挂在 composer 上方，一条一批。
 */
const { requests, ensure, respond, dismiss } = useApproval()

const current = computed(() => requests.value[0] ?? null)
const queued = computed(() => Math.max(0, requests.value.length - 1))

// AUDIT-010：等待时长改为实计时。原实现用 Date.now() 现算，但它不是响应式
// 依赖——除非 requests 变化，模板永远重算不出新值，秒数冻结在挂载那一刻。
// 用 1s interval 驱动 now ref，对话框消失/批准/拒绝即随组件卸载清理。
const now = ref(Date.now())
let waitTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  void ensure()
  waitTimer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
})

onUnmounted(() => {
  if (waitTimer) clearInterval(waitTimer)
  waitTimer = null
})

/** 已等待时长 mm:ss：超一分钟也读得出来，不会溢成「3789s」。 */
const waitText = computed(() => {
  const r = current.value
  if (!r) return '00:00'
  const s = Math.max(0, Math.floor((now.value - r.receivedAt) / 1000))
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${mm}:${ss}`
})
</script>

<template>
  <transition name="approval-slide">
    <div v-if="current" class="approval" role="alertdialog" aria-live="assertive">
      <AppIcon name="lock" :size="15" class="approval-icon" />
      <div class="approval-body">
        <p class="approval-title">{{ current.title || '工具调用需要批准' }}</p>
        <p v-if="current.message" class="approval-msg">{{ current.message }}</p>
        <p class="approval-meta">
          等待批准 {{ waitText }}<span v-if="queued"> · 还有 {{ queued }} 条排队</span>
        </p>
      </div>
      <div class="approval-actions">
        <button type="button" class="approval-btn approve" @click="respond(current.id, true)">
          <AppIcon name="check" :size="13" />
          批准
        </button>
        <button type="button" class="approval-btn reject" @click="respond(current.id, false)">
          <AppIcon name="close" :size="13" />
          拒绝
        </button>
        <button
          type="button"
          class="approval-btn dismiss"
          title="忽略（内核超时后自动拒绝）"
          @click="dismiss(current.id)"
        >
          <AppIcon name="close" :size="13" />
        </button>
      </div>
    </div>
  </transition>
</template>

<style src="./ApprovalDialog.css" scoped></style>
