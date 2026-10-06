<script setup lang="ts">
import { computed, ref } from 'vue'
import { marked } from 'marked'
import AppIcon from '@/components/ui/AppIcon.vue'
import ArtifactCard from './ArtifactCard.vue'
import ArtifactPreview from './ArtifactPreview.vue'
import type { Artifact } from '@/composables/useArtifacts'
import { fmtCost, fmtTokens } from '@/composables/piEvents'

const props = defineProps<{
  messages: any[]
  streaming: boolean
  artifacts: Record<string, Artifact[]>
  root: string
}>()

const open = ref<Artifact | null>(null)

/**
 * 首字未到之前的等待态：已发出、内核还没回任何内容。
 *
 * 没有它，用户发完消息看到的就是「一条孤零零的提问 + 什么都没有」，
 * 无从判断是模型在想、还是根本没送出去。
 */
const waiting = computed(() => {
  if (!props.streaming) return false
  const last = props.messages[props.messages.length - 1]
  return !(last && last.role === 'assistant' && last.text)
})

function render(t: string) {
  return marked.parse(t || '', { breaks: true }) as string
}
</script>

<template>
  <div class="msgs">
    <div v-if="!messages.length" class="empty">
      <span class="empty-icon"><AppIcon name="sparkles" :size="28" /></span>
      <strong>向 Pi 下达编码任务</strong>
      <span class="muted">选好活动项目后，在下方输入框开始对话。</span>
    </div>

    <div v-for="m in messages" :key="m.id" class="msg-row" :class="m.role">
      <div class="msg-avatar">
        <AppIcon v-if="m.role === 'user'" name="user" :size="16" />
        <span v-else-if="m.role === 'assistant'" class="pi-mark">π</span>
        <AppIcon v-else name="settings" :size="14" />
      </div>
      <div class="msg-body">
        <div class="msg-meta">
          <strong>{{ m.role === 'user' ? '你' : m.role === 'assistant' ? 'Pi' : '系统' }}</strong>
        </div>
        <div v-if="m.tool" class="msg-tool">
          <AppIcon name="zap" :size="13" />
          {{ m.tool }}
        </div>
        <!--
          流式输出期间不做 markdown 解析：每条 message_update 都带**累计全文**，
          逐字重渲 + marked.parse 会让主线程在长回复里 O(n²) 饱和，表现为整窗卡死、
          输入法 run loop 同步失败（IMKCFRunLoopWakeUpReliable）。落定（streaming=false）
          后再解析一次即可，渲染成本从「每条事件」降到「每条消息一次」。
        -->
        <div v-else-if="m.role === 'assistant' && m.streaming" class="md streaming">{{ m.text }}</div>
        <div v-else-if="m.role === 'assistant'" class="md" v-html="render(m.text)"></div>
        <div v-else class="txt">{{ m.text }}</div>

        <div v-if="m.attachments?.length" class="msg-attach">
          <span
            v-for="a in m.attachments"
            :key="a.id"
            class="att-ref"
            :class="a.kind"
            :title="a.path"
          >
            <AppIcon :name="a.kind === 'image' ? 'image' : 'file'" :size="13" />
            <span class="att-ref-name">{{ a.name }}</span>
          </span>
        </div>

        <div v-if="(artifacts?.[m.id] ?? []).length" class="acstrip">
          <ArtifactCard
            v-for="a in artifacts[m.id]"
            :key="a.path"
            :artifact="a"
            :active="open?.path === a.path"
            @open="open = $event"
          />
        </div>

        <span v-if="m.streaming" class="cursor">▍</span>

        <div
          v-if="m.role === 'assistant' && m.usage && !m.streaming"
          class="msg-usage"
          :title="`输入 ${m.usage.input} · 输出 ${m.usage.output} · 缓存读 ${m.usage.cacheRead} · 缓存写 ${m.usage.cacheWrite} · 合计 ${m.usage.totalTokens} tokens`"
        >
          <AppIcon name="zap" :size="11" />
          <span>↑{{ fmtTokens(m.usage.input) }}</span>
          <span>↓{{ fmtTokens(m.usage.output) }}</span>
          <span>Σ{{ fmtTokens(m.usage.totalTokens) }}</span>
          <span>{{ fmtCost(m.usage.cost.total) }}</span>
        </div>
      </div>
    </div>

    <!-- 等待模型响应：机器人侧占位气泡，回答首字到达前一直可见 -->
    <div v-if="waiting" class="msg-row assistant waiting">
      <div class="msg-avatar">
        <span class="pi-mark">π</span>
      </div>
      <div class="msg-body">
        <div class="msg-meta">
          <strong>Pi</strong>
        </div>
        <div class="wait-line" role="status">
          <span class="dots" aria-hidden="true"><i /><i /><i /></span>
          <span class="wait-text">等待模型响应…</span>
        </div>
      </div>
    </div>

    <ArtifactPreview
      v-if="open"
      :artifact="open"
      :root="root"
      @close="open = null"
    />
  </div>
</template>

<style src="./MessageList.css" scoped></style>
