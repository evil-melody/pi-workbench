<script setup lang="ts">
import AppIcon from '@/components/ui/AppIcon.vue'
import AppButton from '@/components/ui/AppButton.vue'
import { t } from '@/i18n'

const props = defineProps<{
  /** 三条延续问题；轮转过的顺序由父层传入。 */
  items: string[]
}>()
const emit = defineEmits<{
  pick: [text: string]
  rotate: []
  close: []
}>()
</script>

<template>
  <div v-if="props.items.length" class="suggest-chips">
    <span class="suggest-label">{{ t('接着问') }}</span>
    <button
      v-for="(s, i) in props.items"
      :key="i"
      type="button"
      class="suggest-chip"
      :title="s"
      @click="emit('pick', s)"
    >{{ s }}</button>
    <AppButton
      type="button"
      variant="icon"
      class="suggest-act"
      :title="t('换一批推荐')"
      @click="emit('rotate')"
    ><AppIcon name="arrow-right" :size="13" /></AppButton>
    <AppButton
      type="button"
      variant="icon"
      class="suggest-act"
      :title="t('关闭推荐')"
      @click="emit('close')"
    ><AppIcon name="close" :size="13" /></AppButton>
  </div>
</template>

<style src="./SuggestChips.css" scoped></style>
