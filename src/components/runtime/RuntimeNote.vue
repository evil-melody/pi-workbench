<script setup lang="ts">
/**
 * 非 Tauri 运行时提示条。仅在浏览器预览（`pnpm dev` / 直开构建产物）出现，
 * 告知本层视图的读写命令需要 `pnpm tauri dev` 运行时才能真实落盘与调度。
 */
import AppIcon from '@/components/ui/AppIcon.vue'
import { useRuntime } from '@/composables/useRuntime'

const { isTauri } = useRuntime()
</script>

<template>
  <div v-if="!isTauri" class="runtime-note">
    <AppIcon name="info" :size="14" />
    <span>
      当前为浏览器预览：本页的读写能力走 Tauri 命令，需在
      <code>pnpm tauri dev</code> 运行时中才能实际落盘与调度；浏览器里会提示不可用。
    </span>
  </div>
</template>

<style src="./RuntimeNote.css" scoped></style>
