/**
 * 运行记录多选 / 批量操作的纯逻辑。
 *
 * 选中集用「段号数组」表示（journal 段号全局唯一，比对象引用稳）：
 * 所有变换都返回新数组，组件里直接整体替换，Vue 响应式零心智负担。
 */

/** 切换一条记录的选中态：选中则移除，未选中则追加（保持原有相对顺序）。 */
export function toggleSelected(selected: readonly number[], index: number): number[] {
  return selected.includes(index)
    ? selected.filter((i) => i !== index)
    : [...selected, index]
}

/** 当前可见集合是否已全部选中。空集合视为未全选（没有「全选了一个寂寞」的勾态）。 */
export function allSelected(selected: readonly number[], visible: readonly number[]): boolean {
  return visible.length > 0 && visible.every((i) => selected.includes(i))
}

/** 全选当前可见集合（返回副本，不与入参共享引用）。 */
export function selectAll(visible: readonly number[]): number[] {
  return [...visible]
}
