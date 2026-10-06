import { createApp } from 'vue'
import App from './App.vue'
import router from './router'
import { initTheme } from './theme'
import './styles/base.css'
import './styles/buttons.css'
import './styles/agent-ops.css'

import { installWebLogBridge } from './composables/useWebLog'

// 首屏同步定主题，避免加载瞬间闪一下反色。
initTheme()
// 桌面模式下把前端日志接到终端：运行时缺陷（卡死 / 没反应）靠它留现场。
installWebLogBridge()

createApp(App).use(router).mount('#app')
