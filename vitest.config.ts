import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

/**
 * 单独一份 vitest 配置，避免为测试污染 vite.config.ts 的构建语义。
 *
 * 默认 environment 是 node（多数被测对象是纯函数）；
 * 需要真实挂载组件的用例在文件顶部加 `// @vitest-environment jsdom` 单独覆盖。
 * 挂载 .vue 需要 vue 插件，否则组件用例无法 import 单文件组件。
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
  },
})
