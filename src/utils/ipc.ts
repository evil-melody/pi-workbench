/**
 * IPC 归一化助手。
 *
 * 后端命令返回 `Option<T>` 时序列化结果是 `null`；浏览器预览的 IPC 桩对未知
 * 命令也可能回 `null`。前端把这类返回值直接塞进 `ref` 后，模板里的
 * `xxx.length` / `for (x of xxx)` 会抛 TypeError，Vue 吞掉渲染异常 →
 * 整块面板直接消失（表现为「页面少了一块，还不报错」）。
 *
 * 统一在数据入口归一成安全形状，页面就不必各自防御。
 */

/** 数组命令：null/undefined → 空数组。 */
export function listOf<T>(p: Promise<T[] | null | undefined>): Promise<T[]> {
  return p.then((r) => r ?? [])
}

/** 对象命令：null/undefined → null（页面用 v-if 守卫）。 */
export function valueOf<T>(p: Promise<T | null | undefined>): Promise<T | null> {
  return p.then((r) => r ?? null)
}
