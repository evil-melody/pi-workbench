<template>
  <div class="tree">
    <div class="thead">文件树</div>
    <ul v-if="nodes.length">
      <TreeNode
        v-for="n in nodes"
        :key="n.path"
        :node="n"
        :root="props.root"
        @open="$emit('open', $event)"
      />
    </ul>
    <div v-else class="hint">未加载，请先在「项目」页选择活动项目</div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { fsReadDir, type FileNode } from '@/composables/useFs'
import TreeNode from './TreeNode.vue'

const props = defineProps<{ root: string }>()
const emit = defineEmits<{ (e: 'open', path: string): void }>()
const nodes = ref<FileNode[]>([])

async function load() {
  if (props.root) nodes.value = await fsReadDir(props.root, props.root).catch(() => [])
}

onMounted(load)
watch(() => props.root, load)
</script>

<style src="./FileTree.css" scoped></style>
