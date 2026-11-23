<script setup lang="ts">
import AppIcon from '@/components/ui/AppIcon.vue'
import AppButton from '@/components/ui/AppButton.vue'
import { t } from '@/i18n'
import type { PiQuote } from '@/composables/usePi'

const props = defineProps<{
  quote: PiQuote
  /** 待发送态才有移除键；已发送气泡里的引用是历史记录，删不掉。 */
  removable?: boolean
}>()

const emit = defineEmits<{ remove: [id: string] }>()

/** 一行截断展示：完整原文走 title 悬停，不做展开面板（选区本来就是短片段）。 */
function preview(q: PiQuote): string {
  // widget 引用是产物绝对路径，托盘里显文件名就够了（完整路径在 title）。
  const one = (q.kind === 'widget' && q.source ? q.source : q.text).replace(/\s+/g, ' ').trim()
  return one.length > 60 ? `${one.slice(0, 60)}…` : one
}
</script>

<template>
  <div class="quote-chip" :title="props.quote.text">
    <AppIcon name="quote" :size="14" class="quote-mark" />
    <span class="quote-body">
      <span class="quote-text">{{ preview(props.quote) }}</span>
      <span v-if="props.quote.note" class="quote-note">{{ t('批注：{0}', [props.quote.note]) }}</span>
    </span>
    <AppButton
      v-if="props.removable"
      type="button"
      variant="icon"
      class="quote-x"
      :title="t('移除引用')"
      @click="emit('remove', props.quote.id)"
    >
      <AppIcon name="close" :size="12" />
    </AppButton>
  </div>
</template>

<style src="./QuoteChip.css" scoped></style>
