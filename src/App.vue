<template>
  <div class="app-shell">
    <Sidebar />
    <main class="app-main">
      <!-- 拖拽带在所有页面顶部共用一条（文档流内，不覆盖控件）。 -->
      <DragStrip />
      <div class="app-page">
      <!--
        对话页按「会话轮次」做 key：点「新会话」加一 → 强制重挂载，消息与流式状态清空。
        其余页面按路径做 key：路径一变就重挂载（同路由换参数也不会读到上一条的陈旧数据）。
      -->
      <router-view v-slot="{ Component, route }">
        <component :is="Component" :key="route.name === 'chat' ? `chat-${chatEpoch}` : route.path" />
      </router-view>
      </div>
    </main>

    <CommandPalette />

    <!-- 首次关窗只询问一次：结果由后端持久化，设置页可改回「每次询问」。 -->
    <AppModal :open="closeAsk" :title="t('关闭主窗口')" size="sm" @close="dismissCloseAsk">
      <div class="close-choice">
        <p class="cc-desc">{{ t('选择后不再询问。之后可在「设置 → 桌面与启动」里改回。') }}</p>
        <ul class="cc-list">
          <li>
            <strong>{{ t('驻留后台继续执行') }}</strong>
            <span>{{ t('定时任务照常调度；托盘菜单可打开主窗口、暂停任务或彻底退出。') }}</span>
          </li>
          <li>
            <strong>{{ t('直接退出') }}</strong>
            <span>{{ t('停止调度、停止内核并清理预授权策略文件，进程结束。') }}</span>
          </li>
        </ul>
      </div>
      <template #footer>
        <AppButton variant="secondary" class="cc-btn" @click="quitApp">{{ t('直接退出') }}</AppButton>
        <AppButton variant="primary" class="cc-btn primary" @click="stayInBackground">{{ t('驻留后台') }}</AppButton>
      </template>
    </AppModal>
  </div>
</template>

<script setup lang="ts">
import { t } from '@/i18n'
import AppModal from '@/components/ui/AppModal.vue'
import AppButton from '@/components/ui/AppButton.vue'
import Sidebar from '@/components/layout/Sidebar.vue'
import CommandPalette from '@/components/search/CommandPalette.vue'
import { chatEpoch } from '@/composables/useChatSession'
import DragStrip from '@/components/layout/DragStrip.vue'
import { useBackground } from '@/composables/useBackground'
import { invoke } from '@tauri-apps/api/core'
import { onBeforeUnmount, onMounted } from 'vue'
import { isTauriRuntime } from '@/composables/useRuntime'
import { setLocalePreference } from '@/i18n'
import { stopRunActivity } from '@/composables/useRunActivity'
import { stopApproval } from '@/composables/useApproval'
import { uninstallWebLogBridge } from '@/composables/useWebLog'

const { closeAsk, dismissCloseAsk, resolveClose } = useBackground()

// 模块级监听/计时器/console 劫持的唯一释放点：根组件卸载时统一收口。
onBeforeUnmount(() => {
  stopRunActivity()
  stopApproval()
  uninstallWebLogBridge()
})

// settings.json 是语言权威：首屏先用缓存，启动后再按设置校正一次。
// 同时挂 macOS Overlay 标记：tauri.conf 已把系统白条换成 Overlay + hiddenTitle，
// 红绿灯浮在左上角 —— 侧栏 brand 给它让位（样式见 layout.css 的 html.mac-overlay），
// 浏览器预览 / Windows / Linux 不加这个类，布局零变化。
onMounted(async () => {
  if (isTauriRuntime() && /Mac|iPod|iPhone|iPad/i.test(navigator.platform)) {
    document.documentElement.classList.add('mac-overlay')
  }
  if (!isTauriRuntime()) return
  try {
    const settings = await invoke<{ language?: string | null }>('settings_load')
    setLocalePreference(settings.language)
  } catch {
    // 读不到设置时保持首屏缓存的选择。
  }
})

function quitApp() {
  void resolveClose('quit').catch((e) => console.error('退出失败', e)) // i18n-ignore: developer log
}

function stayInBackground() {
  void resolveClose('background').catch((e) => console.error('隐藏窗口失败', e)) // i18n-ignore: developer log
}
</script>

<style src="./styles/layout.css" scoped></style>
