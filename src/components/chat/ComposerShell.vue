<script setup lang="ts">
/**
 * 输入区外壳：落地页与会话态共用同一个容器。
 *
 * 外框只出现在这一层；内部的选择器 / 图标键一律去掉描边与底色，
 * 靠间距和 hover 底色区分，不再「一行行带框控件堆在一起」。
 * 样式非 scoped：需要命中 AppTextarea / AppSelect / WorkspacePicker 的内部节点，
 * 全部规则都收在 `.composer-shell` 前缀下。
 */
</script>

<template>
  <div class="composer-shell">
    <slot name="tray" />
    <slot />
    <div class="composer-shell-bar">
      <div class="composer-shell-left"><slot name="left" /></div>
      <div class="composer-shell-right"><slot name="right" /></div>
    </div>
  </div>
</template>

<style src="./ComposerShell.css"></style>
