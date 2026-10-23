import { describe, expect, it } from 'vitest'
import { allSelected, selectAll, toggleSelected } from '@/utils/runSelection'

/** 多选纯逻辑：选中集是段号数组，变换必须不可变（返回新数组）。 */
describe('toggleSelected', () => {
  it('未选中 → 追加', () => {
    expect(toggleSelected([1, 3], 2)).toEqual([1, 3, 2])
  })

  it('已选中 → 移除', () => {
    expect(toggleSelected([1, 2, 3], 2)).toEqual([1, 3])
  })

  it('不修改入参（Vue 直接整体替换，零脏读）', () => {
    const src = [1, 2]
    const out = toggleSelected(src, 3)
    expect(src).toEqual([1, 2])
    expect(out).not.toBe(src)
  })
})

describe('allSelected', () => {
  it('空可见集合 = 未全选（不出现「全选了一个寂寞」的勾态）', () => {
    expect(allSelected([], [])).toBe(false)
  })

  it('部分选中 / 全部选中', () => {
    expect(allSelected([1], [1, 2])).toBe(false)
    expect(allSelected([2, 1], [1, 2])).toBe(true)
  })
})

describe('selectAll', () => {
  it('返回可见集合的副本（不与入参共享引用）', () => {
    const visible = [1, 2, 3]
    const out = selectAll(visible)
    expect(out).toEqual([1, 2, 3])
    expect(out).not.toBe(visible)
  })
})
