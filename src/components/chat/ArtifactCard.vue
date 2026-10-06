<script setup lang="ts">
import { computed } from 'vue'
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
  if (props.artifact.lines > 0) bits.push(`${props.artifact.lines} 行`)
  return bits.join(' · ')
})
</script>

<template>
  <button
    type="button"
    class="acard"
    :class="{ on: active }"
    :title="artifact.path"
    @click="emit('open', artifact)"
  >
    <span class="glyph">{{ glyph }}</span>
    <span class="meta">
      <span class="name">{{ artifact.name }}</span>
      <span class="sub">{{ meta }}</span>
    </span>
  </button>
</template>

<style src="./ArtifactCard.css" scoped></style>
