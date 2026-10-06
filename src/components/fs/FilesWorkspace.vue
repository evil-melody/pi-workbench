<script setup lang="ts">
/**
 * 项目文件工作区：左侧文件树 + 右侧编辑面板。
 *
 * 位置说明：它属于「项目详情页」，**不再常驻对话页**。
 * 对话页要像正常对话产品那样把宽度留给消息，文件/终端/浏览器在项目页里按 tab 看。
 */
import { ref, watch } from 'vue'
import FileTree from '@/components/fs/FileTree.vue'
import FileEditorPane from '@/components/fs/FileEditorPane.vue'

const props = defineProps<{ root: string }>()

const current = ref('')
// 换项目就不能留着上一个项目的选中路径，否则编辑面板会拿旧路径去读新目录。
watch(
  () => props.root,
  () => {
    current.value = ''
  },
)
</script>

<template>
  <div class="fws">
    <aside class="fws-tree">
      <p class="fws-root" :title="root">{{ root }}</p>
      <div class="fws-tree-body">
        <FileTree :root="root" @open="current = $event" />
      </div>
    </aside>
    <section class="fws-main">
      <FileEditorPane :root="root" :path="current" />
    </section>
  </div>
</template>

<style src="./FilesWorkspace.css" scoped></style>
