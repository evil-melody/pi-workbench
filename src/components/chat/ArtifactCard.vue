<script setup lang="ts">import { t } from '@/i18n'

import { computed } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import { formatBytes, type Artifact, type ArtifactKind } from '@/composables/useArtifacts'

const props = defineProps<{
  artifact: Artifact
  active: boolean
}>()

const emit = defineEmits<{
  open: [Artifact]
  /** #66 M9：hover 快捷「添加到对话」——把产物路径摘成引用，不用先开预览。 */
  quote: [Artifact]
}>()

const GLYPH: Record<ArtifactKind, string> = {
  html: '</>',
  markdown: '#',
  json: '{ }',
  svg: '<svg>',
  image: '▣',
  text: '≡',
  docx: 'Word',
  xlsx: 'XLS',
  pptx: 'PPT',
  pdf: 'PDF',
}

const glyph = computed(() => GLYPH[props.artifact.kind] ?? '≡')
const meta = computed(() => {
  const bits = [formatBytes(props.artifact.bytes)]
  if (props.artifact.lines > 0) bits.push(t('{0} 行', [props.artifact.lines]))
  return bits.join(' · ')
})
</script>

<template>
  <!-- 外层 wrapper 只为承载 hover 操作键：卡片本体是 button，
       往里再塞 button 是非法 HTML，点击行为会被浏览器打乱。 -->
  <div class="acard-wrap">
    <AppButton
      variant="card"
      class="acard"
      :class="{ on: active }"
      :aria-current="active ? 'true' : undefined"
      :title="artifact.path"
      @click="emit('open', artifact)"
    >
      <span class="glyph">{{ glyph }}</span>
      <span class="meta">
        <span class="name">{{ artifact.name }}</span>
        <span class="sub">{{ meta }}</span>
      </span>
    </AppButton>
    <div class="acard-acts">
      <AppButton
        type="button"
        variant="icon"
        class="acard-act"
        :title="t('添加到对话')"
        :aria-label="t('添加到对话')"
        @click.stop="emit('quote', artifact)"
      >
        <AppIcon name="quote" :size="13" />
      </AppButton>
    </div>
  </div>
</template>

<style src="./ArtifactCard.css" scoped></style>
