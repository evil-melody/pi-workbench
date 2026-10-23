import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { ref } from 'vue'
import { IN_TAURI } from '@/composables/usePi'

/**
 * B1 硬审批的前端回路：
 *
 * Pi 扩展（agent-tool-gate）在内核里调 `ctx.ui.confirm(...)` 时，内核经 stdout
 * 发出一行 `{"type":"extension_ui_request","id":<uuid>,"method":"confirm",...}`，
 * 桥（pi_bridge reader）原样转成 `pi://event` 推到前端；用户在 UI 上点
 * 批准/拒绝后，宿主经 `pi_ui_response` 回送
 * `{"type":"extension_ui_response","id","confirmed":bool}`，内核按 id 解析。
 *
 * 用户不回应（关掉了通知 / 事件丢失）时，扩展侧超时兜底 fail-closed，
 * 所以前端只管展示与回送，不需要做超时逻辑。
 */
export interface ApprovalRequest {
  /** 对应 extension_ui_request 的 uuid。 */
  id: string
  method: string
  title?: string
  message?: string
  /** 收到时刻，供 UI 展示等待时长。 */
  receivedAt: number
}

/** 模块级单例：与 useUsageStore 同款，多组件共享同一份待审批队列。 */
const requests = ref<ApprovalRequest[]>([])
let un: UnlistenFn | null = null
let started = false

/** 队列里最多挂多少条，防止异常内核刷屏。 */
const MAX_PENDING = 5

export function useApproval() {
  /** 订阅 pi://event 里的 extension_ui_request。幂等，可多次调用。 */
  async function ensure() {
    if (!IN_TAURI || started) return
    started = true
    un = await listen<any>('pi://event', (e) => {
      const rec = e.payload
      if (rec?.type !== 'extension_ui_request' || !rec?.id) return
      // 只交互 confirm：notify/setStatus/setWidget/setTitle 是纯通知，无需回应。
      if (rec?.method && rec.method !== 'confirm') return
      if (requests.value.some((r) => r.id === rec.id)) return
      requests.value.push({
        id: rec.id,
        method: rec.method ?? 'confirm',
        ...(rec.title ? { title: rec.title } : {}),
        ...(rec.message ? { message: rec.message } : {}),
        receivedAt: Date.now(),
      })
      if (requests.value.length > MAX_PENDING) requests.value.splice(0, 1)
    })
  }

  /** 回应用户决定：批准 confirmed=true / 拒绝 confirmed=false。失败静默（扩展会超时兜底）。 */
  async function respond(id: string, confirmed: boolean) {
    requests.value = requests.value.filter((r) => r.id !== id)
    if (!IN_TAURI) return
    await invoke('pi_ui_response', {
      json: JSON.stringify({ type: 'extension_ui_response', id, confirmed }),
    }).catch(() => {})
  }

  /** 不回应直接清掉（用户关掉横幅）——扩展侧超时后 fail-closed。 */
  function dismiss(id: string) {
    requests.value = requests.value.filter((r) => r.id !== id)
  }

  return { requests, ensure, respond, dismiss }
}
