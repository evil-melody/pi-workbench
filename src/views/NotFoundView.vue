<script setup lang="ts">
/**
 * 404 兜底页（AUDIT-006）。
 *
 * 原来路由表没有 catch-all：hash 路由拼错 / 旧书签 / 外部链接指向不存在的路径时，
 * vue-router 静默不匹配，页面整片空白——用户得到的是「白屏」而不是「路走错了」。
 */
import { useRouter } from 'vue-router'

const router = useRouter()

function backHome() {
  router.replace('/chat')
}
</script>

<template>
  <section class="not-found">
    <div class="nf-card">
      <span class="nf-code">404</span>
      <h1 class="nf-title">页面不存在</h1>
      <p class="nf-desc">这个路径没有对应的功能页。可能是链接已失效，或地址拼写有误。</p>
      <button type="button" class="nf-btn" @click="backHome">返回对话</button>
    </div>
  </section>
</template>

<style src="./NotFoundView.css" scoped></style>
