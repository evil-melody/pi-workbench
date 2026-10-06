<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { invoke } from '@tauri-apps/api/core'
import AppIcon from '@/components/ui/AppIcon.vue'
import { fmtCost, fmtTokens } from '@/composables/piEvents'
import { useUsageStore } from '@/composables/useUsageStore'
import { isTauriRuntime } from '@/composables/useRuntime'

/**
 * 侧栏底部的**实时用量卡**。
 *
 * 数据全部来自内核 `pi://event` 上报的真实用量（见 `useUsageStore`）——
 * 没有数据时显示「等待对话」，绝不用占位数字冒充额度。
 *
 * 余额只在用户真的写了 `billing.json` 时才出现：Pi 没有统一计费接口，
 * 凭空显示一个余额等于对用户撒谎。
 */
interface BillingStatus {
  balance: number
  today: number
  period_label: string
  period_until: string
  demo: boolean
}

const router = useRouter()
const usage = useUsageStore()
const inTauri = isTauriRuntime()

/** 只有非 demo 的真实计费数据才展示；demo 值一律不显示。 */
const billing = ref<BillingStatus | null>(null)

async function loadBilling() {
  if (!inTauri) return
  const s = await invoke<BillingStatus>('billing_status').catch(() => null)
  billing.value = s && !s.demo ? s : null
}

const inputTokens = computed(() => usage.run.value.input)
const outputTokens = computed(() => usage.run.value.output)
const totalTokens = computed(() => usage.run.value.totalTokens)
const cost = computed(() => usage.run.value.cost)

/** 输入 / 输出占比：用于那条三段色条，视觉上反映 prompt 与 completion 的比例。 */
const ratio = computed(() => {
  const i = inputTokens.value
  const o = outputTokens.value
  const sum = i + o
  if (!sum) return { i: 0, o: 0 }
  return { i: (i / sum) * 100, o: (o / sum) * 100 }
})

const stamp = computed(() => {
  if (!usage.updatedAt.value) return ''
  const t = new Date(usage.updatedAt.value)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())} 更新`
})

onMounted(() => {
  void usage.ensure()
  void loadBilling()
})
</script>

<template>
  <div class="usage-card" :class="{ live: usage.hasData.value }">
    <div class="uc-head">
      <span class="uc-title">
        <AppIcon name="zap" :size="12" />
        <span>实时用量</span>
      </span>
      <span v-if="usage.hasData.value" class="uc-live" title="内核正在上报真实用量">实时</span>
    </div>

    <template v-if="usage.hasData.value">
      <div class="uc-grid">
        <div class="uc-cell">
          <span class="uc-k">提示词</span>
          <span class="uc-v">↑{{ fmtTokens(inputTokens) }}</span>
        </div>
        <div class="uc-cell">
          <span class="uc-k">输出</span>
          <span class="uc-v">↓{{ fmtTokens(outputTokens) }}</span>
        </div>
        <div class="uc-cell">
          <span class="uc-k">总计</span>
          <span class="uc-v strong">Σ{{ fmtTokens(totalTokens) }}</span>
        </div>
        <div class="uc-cell">
          <span class="uc-k">花费</span>
          <span class="uc-v">{{ fmtCost(cost) }}</span>
        </div>
      </div>

      <div class="uc-bar" aria-hidden="true">
        <i class="bar-in" :style="{ width: `${ratio.i}%` }" />
        <i class="bar-out" :style="{ width: `${ratio.o}%` }" />
      </div>

      <p class="uc-foot">
        调用 {{ usage.calls.value }} 次 · 轮次 {{ usage.turns.value }}
        <template v-if="stamp"> · {{ stamp }}</template>
      </p>
    </template>

    <p v-else class="uc-empty">
      <template v-if="inTauri">还没有用量数据 —— 开始一轮对话后在这里实时统计。</template>
      <template v-else>需在桌面 App 内查看</template>
    </p>

    <div v-if="billing" class="uc-billing">
      <span>余额 ¥{{ billing.balance.toFixed(2) }}</span>
      <span>今日 ¥{{ billing.today.toFixed(4) }}</span>
    </div>

    <button v-else class="uc-link" title="Pi 暂无统一计费接口，余额需在 app_config_dir/billing.json 提供" @click="router.push('/settings')">
      <AppIcon name="external" :size="11" />
      <span>未接入余额计费</span>
    </button>
  </div>
</template>

<style src="./UsageCard.css" scoped></style>
