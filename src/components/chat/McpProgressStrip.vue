<script setup lang="ts">
import { t } from '@/i18n'
/**
 * #66 M8：MCP 加载进度条（对话流临时条）。
 *
 * 数据源是连接器握手态（connectors_list 轮询），不是消息流——所以它
 * 不落历史、不进 MessageList，全就绪后自动消失。WorkBuddy 语义：
 * 「正在连接 N/总数」→ 展开按已连/未连分组 → 「所有 MCP 服务已就绪」。
 *
 * 后端 discovering 是同步握手的瞬时态（spawn_and_register 几十毫秒），
 * 快握手时这条可能一闪而过甚至不出现——这是诚实行为，不是缺陷；
 * 慢启动（stdio 冷进程、多连接器）时它就是用户唯一能看到进度的地方。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { connectorsList, stateText, type ConnectorSummary } from '@/composables/useConnectors'
import AppIcon from '@/components/ui/AppIcon.vue'

const POLL_MS = 600
/** 就绪/失败汇总态驻留时长：够读完，又不赖着不走。 */
const DONE_LINGER_MS = 3000

type Phase = 'idle' | 'connecting' | 'done' | 'failed'
const phase = ref<Phase>('idle')
const list = ref<ConnectorSummary[]>([])
const expanded = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null

/** 参与握手的集合：停用的不算「总数」，否则永远到不了全就绪。 */
const active = () => list.value.filter((c) => c.state !== 'disabled')
const pending = () => active().filter((c) => c.state === 'discovering')
const connected = () => active().filter((c) => c.state === 'ready')
const broken = () => active().filter((c) => c.state === 'offline')

function stopTimers() {
  if (timer) clearTimeout(timer)
  if (hideTimer) clearTimeout(hideTimer)
  timer = hideTimer = null
}

async function poll() {
  try {
    list.value = await connectorsList()
  } catch {
    // 连接器面挂了不阻断对话本身：条直接退场。
    stopTimers()
    phase.value = 'idle'
    return
  }
  const act = active()
  if (!act.length) {
    // 一个都没启用：没有加载过程可展示，安静退场。
    phase.value = 'idle'
    stopTimers()
    return
  }
  if (pending().length) {
    phase.value = 'connecting'
    return
  }
  // 握手收敛：有离线给失败汇总（不自动消失——那是需要用户处理的状态），
  // 全就绪给成功条（驻留后消失，临时条的使命到此结束）。
  phase.value = broken().length ? 'failed' : 'done'
  stopTimers()
  // failed 不自动消失（需要用户去连接器面板处理）；done 是临时条，读完就走。
  if (phase.value === 'done') hideTimer = setTimeout(() => (phase.value = 'idle'), DONE_LINGER_MS)
}

/** 轮询链：一次落地再排下一次，避免慢 IPC 下请求叠罗汉。 */
function tick() {
  void (async () => {
    await poll()
    if (phase.value === 'connecting') timer = setTimeout(tick, POLL_MS)
  })()
}

// 组件生命周期即「本轮观测窗口」：ChatView 会话态挂载即开始轮询，卸载即停。
onMounted(() => {
  expanded.value = false
  tick()
})
onBeforeUnmount(stopTimers)
</script>

<template>
  <div v-if="phase !== 'idle'" class="mcp-strip" :class="phase" role="status">
    <button type="button" class="mcp-head" @click="expanded = !expanded">
      <AppIcon v-if="phase === 'connecting'" name="refresh" :size="13" class="mcp-spin" />
      <AppIcon v-else-if="phase === 'failed'" name="alert-triangle" :size="13" class="mcp-warn" />
      <AppIcon v-else name="check" :size="13" class="mcp-ok" />
      <span class="mcp-text">
        <template v-if="phase === 'connecting'">{{ t('正在连接 MCP 服务 {0}/{1}', [connected().length + broken().length, active().length]) }}<template v-if="pending().length"> · {{ t('握手中 {0}', [pending().length]) }}</template></template>
        <template v-else-if="phase === 'done'">{{ t('所有 MCP 服务已就绪') }}</template>
        <template v-else>{{ t('MCP 连接完成：已连 {0}，异常 {1}', [connected().length, broken().length]) }}</template>
      </span>
      <span class="mcp-caret">{{ expanded ? t('收起') : t('展开') }}</span>
    </button>
    <div v-if="expanded" class="mcp-groups">
      <div v-if="connected().length" class="mcp-group ok">
        <span class="mcp-group-title">{{ t('已连') }} · {{ connected().length }}</span>
        <span v-for="c in connected()" :key="c.id" class="mcp-item" :title="c.diagnostic ?? ''">
          <AppIcon name="check" :size="11" />{{ c.title }}
        </span>
      </div>
      <div v-if="pending().length" class="mcp-group pend">
        <span class="mcp-group-title">{{ t('未连') }} · {{ pending().length }}</span>
        <span v-for="c in pending()" :key="c.id" class="mcp-item" :title="stateText(c.state)">
          <AppIcon name="refresh" :size="11" class="mcp-spin" />{{ c.title }}
        </span>
      </div>
      <div v-if="broken().length" class="mcp-group bad">
        <span class="mcp-group-title">{{ t('连接异常') }} · {{ broken().length }}</span>
        <span v-for="c in broken()" :key="c.id" class="mcp-item" :title="c.diagnostic ?? ''">
          <AppIcon name="alert-triangle" :size="11" />{{ c.title }}
        </span>
      </div>
    </div>
  </div>
</template>

<style src="./McpProgressStrip.css" scoped></style>
