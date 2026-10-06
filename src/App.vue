<template>
  <div class="app-shell">
    <Sidebar />
    <main class="app-main">
      <!--
        对话页按「会话轮次」做 key：点「新会话」加一 → 强制重挂载，消息与流式状态清空。
        其余页面按路径做 key：路径一变就重挂载（同路由换参数也不会读到上一条的陈旧数据）。
      -->
      <router-view v-slot="{ Component, route }">
        <component :is="Component" :key="route.name === 'chat' ? `chat-${chatEpoch}` : route.path" />
      </router-view>
    </main>
  </div>
</template>

<script setup lang="ts">
import Sidebar from '@/components/layout/Sidebar.vue'
import { chatEpoch } from '@/composables/useChatSession'
</script>

<style src="./styles/layout.css" scoped></style>
