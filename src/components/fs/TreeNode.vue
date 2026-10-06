<template>
  <li>
    <div class="node" @click="toggle">
      <span class="tw">{{ node.is_dir ? (open ? '▾' : '▸') : '·' }}</span>
      <span class="nm" :class="{ dir: node.is_dir }" @click.stop="onPick">{{ node.name }}</span>
    </div>
    <ul v-if="node.is_dir && open && children.length">
      <TreeNode
        v-for="c in children"
        :key="c.path"
        :node="c"
        :root="props.root"
        @open="$emit('open', $event)"
      />
    </ul>
  </li>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { fsReadDir, type FileNode } from '@/composables/useFs'

const props = defineProps<{ node: FileNode; root: string }>()
const emit = defineEmits<{ (e: 'open', path: string): void }>()

const open = ref(false)
const children = ref<FileNode[]>([])

async function toggle() {
  if (!props.node.is_dir) return
  open.value = !open.value
  if (open.value && !children.value.length)
    children.value = await fsReadDir(props.node.path, props.root).catch(() => [])
}

function onPick() {
  if (!props.node.is_dir) emit('open', props.node.path)
}
</script>

<style src="./TreeNode.css" scoped></style>
