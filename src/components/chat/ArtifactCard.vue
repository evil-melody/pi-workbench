<script setup lang="ts">import { t } from '@/i18n'

import { computed } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import { formatBytes, type Artifact, type ArtifactKind } from '@/composables/useArtifacts'

const props = defineProps<{
  artifact: Artifact
  active: boolean
}>()

const emit = defineEmits<{ open: [Artifact] }>()

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
</template>

<style src="./ArtifactCard.css" scoped></style>
