/**
 * Promise 硬超时护栏。
 *
 * 背景：dispatch 链路上的 Tauri invoke 若遇到主线程被堵（非 async 命令排队）
 * 可能永不 settle，`await` 后面的所有逻辑（落消息、切视图、下发内核）全部
 * 静默卡死——表现为「终端有 dispatch 日志，页面毫无反应」。
 * 这里给它一层兜底：超时或失败都落到 `fallback`，绝不挂起调用方。
 *
 * 注意：超时后原 promise 仍在后台跑（无法取消），只是不再阻塞主流程。
 * 纯工具、无依赖，vitest 可直接跑（tests/asyncGuard.spec.ts）。
 */
export function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false
    const finish = (v: T) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(v)
    }
    const timer = setTimeout(() => finish(fallback), ms)
    p.then(finish, () => finish(fallback))
  })
}
