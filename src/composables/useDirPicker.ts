import { open } from '@tauri-apps/plugin-dialog'

/**
 * 打开原生目录选择器，返回所选绝对路径。
 *
 * 在浏览器环境（vitest / 开发预览）里插件不可用，此时返回 null，
 * 由调用方回退到手动输入路径，不阻塞流程。
 */
export async function pickDirectory(defaultPath?: string): Promise<string | null> {
  try {
    const picked = await open({
      directory: true,
      multiple: false,
      ...(defaultPath ? { defaultPath } : {}),
    })
    return typeof picked === 'string' && picked ? picked : null
  } catch {
    return null
  }
}

/** 等待系统选择器的上限：超时复位，绝不把界面永久停在「正在选择…」。 */
export const PICK_TIMEOUT_MS = 120_000

/**
 * 超时提示文案：三处入口（工作目录选择器、首页发送、侧栏切项目）共用一句，
 * 否则同一个故障在不同界面上会被描述成三件不同的事。
 */
export const PICK_TIMEOUT_NOTE = '系统目录选择器没有返回，已复位 —— 可以再点一次。'

export interface GuardedPick {
  /** 选中的目录；未选 / 超时 / 已取消时为 null。 */
  dir: string | null
  /** 系统选择器超时未返回（不是用户取消）——调用方应据此提示，而不是静默当取消。 */
  timedOut: boolean
}

/**
 * 代际计数：一次选择可能因为超时或用户手动取消而作废，
 * 但系统选择器**之后**才返回，这时它的结果必须被丢掉，否则会把用户已经改过的状态又覆盖一次。
 */
let generation = 0

/** 作废当前这次等待（供 UI 提供「取消」出口，不必等系统选择器自己回来）。 */
export function cancelPendingPick(): void {
  generation += 1
}

/**
 * 带超时 + 代际丢弃的目录选择。
 *
 * 单独抽出来是因为有两处入口（工作目录选择器、首页「先选目录再发送」），
 * 而这两处都必须具备同样的兜底：`open()` 一旦不返回（原生弹窗被系统吞掉、
 * 主线程被占住等），用户就再也点不动了。
 */
export async function pickDirectoryGuarded(
  defaultPath?: string,
  timeoutMs: number = PICK_TIMEOUT_MS,
): Promise<GuardedPick> {
  const mine = ++generation
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  try {
    const picked = await Promise.race([pickDirectory(defaultPath), timeout])
    if (mine !== generation) return { dir: null, timedOut: false }
    if (picked === 'timeout') return { dir: null, timedOut: true }
    return { dir: picked, timedOut: false }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
