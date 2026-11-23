import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { readonly, ref } from 'vue'

export type CloseAction = 'ask' | 'background' | 'quit'

export interface BackgroundInfo {
  close_action: CloseAction
  paused: boolean
  autostart: boolean
}

const info = ref<BackgroundInfo>({ close_action: 'ask', paused: false, autostart: false })
/** 首次关窗的询问框：仅后端发事件时打开，不持久化。 */
const closeAsk = ref(false)
let listening = false

async function refresh(): Promise<BackgroundInfo> {
  const next = await invoke<BackgroundInfo>('background_get')
  info.value = next
  return next
}

function ensureListener() {
  if (listening) return
  listening = true
  void listen('background://ask-close', () => {
    closeAsk.value = true
  })
  void listen('background://changed', () => {
    void refresh()
  })
}

/** 关窗询问被用户直接关掉：不落偏好，下次关闭继续询问。 */
function dismissCloseAsk() {
  closeAsk.value = false
}

async function setCloseAction(action: CloseAction): Promise<BackgroundInfo> {
  const next = await invoke<BackgroundInfo>('background_set_close_action', { action })
  info.value = next
  return next
}

/** 首次询问的结果：后端据此持久化并隐藏窗口或退出进程。 */
async function resolveClose(action: Exclude<CloseAction, 'ask'>) {
  closeAsk.value = false
  await invoke('background_resolve_close', { action })
}

async function setAutostart(enabled: boolean): Promise<boolean> {
  const actual = await invoke<boolean>('background_set_autostart', { enabled })
  info.value = { ...info.value, autostart: actual }
  return actual
}

async function setPaused(paused: boolean): Promise<BackgroundInfo> {
  const next = await invoke<BackgroundInfo>('background_set_paused', { paused })
  info.value = next
  return next
}

export function useBackground() {
  ensureListener()
  return {
    info: readonly(info),
    closeAsk: readonly(closeAsk),
    refresh,
    dismissCloseAsk,
    setCloseAction,
    resolveClose,
    setAutostart,
    setPaused,
  }
}
