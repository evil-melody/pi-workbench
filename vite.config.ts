import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'

export default defineConfig({
  plugins: [vue()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: false,
    // HMR 复用本次 serving 端口（默认行为）。写死独立端口会让同仓第二个
    // Vite 实例（dev:web / app:dev 并行）抢不到 WS，客户端反复重连并整页 reload。
    hmr: { protocol: 'ws', host: 'localhost' },
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'es2021',
    outDir: 'dist',
    emptyOutDir: true,
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
})
