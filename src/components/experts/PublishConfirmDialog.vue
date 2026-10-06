<script setup lang="ts">
/**
 * 发布确认弹窗 —— ADR-0017 #5 的「人」这一环。
 *
 * 这是整条发布链路上唯一会被人类点下去的按钮。它做三件事：
 *   1. 把要发布的内容摊开给看（名称 / 摘要 / 草稿修订 / 有效期）；
 *   2. 把后端铸好的 challenge 换成一次性 proof —— 这一步只在点击「我确认发布」时发生；
 *   3. 由父组件拿 proof 去调 expert_publish，后端会重新比对摘要。
 *
 * 所以：关掉弹窗、内容改一个字、超过 5 分钟，proof 都会作废，发布必定失败。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import type { ConfirmationRequest } from '@/composables/useExperts'

const props = defineProps<{
  open: boolean
  challenge: ConfirmationRequest | null
  expertName: string
  publishing: boolean
}>()

const emit = defineEmits<{
  cancel: []
  confirmed: [token: string]
}>()

/** 剩余毫秒每秒重算，用于「5 分钟后自动失效」的真实倒计时而不是静态文案。 */
const now = ref(Date.now())
let timer: number | undefined

function start() {
  stop()
  timer = window.setInterval(() => (now.value = Date.now()), 1000)
}
function stop() {
  if (timer) window.clearInterval(timer)
  timer = undefined
}
watch(
  () => props.open,
  (v) => (v ? start() : stop()),
)
onBeforeUnmount(stop)

const remainMs = computed(() => {
  if (!props.challenge) return 0
  return Math.max(0, props.challenge.expires_at - now.value)
})

const remainText = computed(() => {
  const total = Math.floor(remainMs.value / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
})

function confirm() {
  const token = props.challenge?.confirmation_token
  if (!token || props.publishing) return
  emit('confirmed', token)
}

function shortDigest(digest: string) {
  return digest.length > 16 ? `${digest.slice(0, 12)}…${digest.slice(-4)}` : digest
}
</script>

<template>
  <Teleport to="body">
    <Transition name="modal">
      <div v-if="open" class="pc-backdrop" role="dialog" aria-modal="true" @click.self="emit('cancel')">
        <div class="pc-panel">
          <div class="pc-head">
            <span class="pc-badge"><AppIcon name="lock" :size="14" /></span>
            <div>
              <h3>确认发布专家</h3>
              <p class="pc-sub">发布会把这份人格写入 Pi 的角色文件，内核下一轮对话即生效。</p>
            </div>
          </div>

          <dl class="pc-list">
            <div><dt>专家</dt><dd>{{ expertName || '（未命名）' }}</dd></div>
            <div>
              <dt>内容摘要</dt>
              <dd class="mono">{{ shortDigest(challenge?.definition_digest ?? '') }}</dd>
            </div>
            <div>
              <dt>草稿修订</dt>
              <dd class="mono">#{{ challenge?.draft_revision ?? '—' }}</dd>
            </div>
            <div>
              <dt>授权有效期</dt>
              <dd class="pc-expire" :class="{ urgent: remainMs > 0 && remainMs < 60_000 }">
                {{ remainMs > 0 ? remainText : '已过期' }}
              </dd>
            </div>
          </dl>

          <p class="pc-note">
            授权是一次性的：确认后如果回头改了任何内容，或超过有效期，发布都会被后端拒绝，
            需要重新确认。
          </p>

          <div class="pc-actions">
            <button class="pc-btn" :disabled="publishing" @click="emit('cancel')">取消</button>
            <button class="pc-btn primary" :disabled="publishing || !challenge" @click="confirm">
              {{ publishing ? '发布中…' : '我确认发布' }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style src="./PublishConfirmDialog.css" scoped></style>
