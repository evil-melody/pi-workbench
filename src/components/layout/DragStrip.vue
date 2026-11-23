<template>
  <!--
    macOS Overlay 标题栏下的窗口拖拽带。放在各视图根容器顶部（文档流内，
    不覆盖控件——绝对定位覆盖层会拦住页面按钮，已实证失败）。
    浏览器预览 / Windows / Linux 不挂 html.mac-overlay，零占位。
  -->
  <div class="drag-strip" data-tauri-drag-region aria-hidden="true" />
</template>

<style scoped>
.drag-strip {
  display: none;
}
html.mac-overlay .drag-strip {
  display: block;
  flex-shrink: 0;
  height: 28px;
}
</style>
