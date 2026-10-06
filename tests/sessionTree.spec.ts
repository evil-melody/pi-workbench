import { describe, expect, it } from 'vitest'
import { flattenTree, summarize, type PiTreeNode } from '@/composables/useSessionTree'

function msg(id: string, role: string, content: string, timestamp = '2026-09-26T10:00:00Z') {
  return {
    entry: { id, type: 'message', parentId: null, timestamp, message: { role, content } },
    children: [],
  } satisfies PiTreeNode
}

describe('flattenTree', () => {
  it('空树返回空列表', () => {
    expect(flattenTree([], null)).toEqual([])
  })

  it('深度优先展开，同层兄弟都是 depth 0', () => {
    const tree: PiTreeNode[] = [msg('a', 'user', 'A'), msg('b', 'assistant', 'B')]
    const flat = flattenTree(tree, 'b')
    expect(flat.map((f) => f.id)).toEqual(['a', 'b'])
    expect(flat.map((f) => f.depth)).toEqual([0, 0])
  })

  it('子节点 depth 比父节点深一层', () => {
    const nested: PiTreeNode = {
      entry: { id: 'a', type: 'message', parentId: null, message: { role: 'user', content: 'A' } },
      children: [msg('b', 'assistant', 'B')],
    }
    expect(flattenTree([nested], 'b').map((f) => f.depth)).toEqual([0, 1])
  })

  it('只有 leafId 命中的节点被标记为末端', () => {
    const flat = flattenTree([msg('a', 'user', 'A'), msg('b', 'assistant', 'B')], 'b')
    expect(flat.map((f) => f.isLeaf)).toEqual([false, true])
    expect(flattenTree([msg('a', 'user', 'A')], null)[0].isLeaf).toBe(false)
  })

  it('同层多节点时把 hasBranch 回填给所有行，不只第一行', () => {
    const branched = [msg('x', 'user', 'X'), msg('y', 'user', 'Y')]
    const flat = flattenTree(branched, 'x')
    expect(flat).toHaveLength(2)
    expect(flat.every((f) => f.hasBranch)).toBe(true)
  })

  it('单节点不算分叉', () => {
    const flat = flattenTree([msg('x', 'user', 'X')], 'x')
    expect(flat[0].hasBranch).toBe(false)
  })

  it('摘要取正文；多块数组拼接后展示', () => {
    const node: PiTreeNode = {
      entry: {
        id: 'm',
        type: 'message',
        parentId: null,
        message: { role: 'assistant', content: [{ text: '第一段' }, { text: '第二段' }] },
      },
      children: [],
    }
    expect(flattenTree([node], 'm')[0].text).toBe('第一段第二段')
  })
})

describe('summarize', () => {
  it('message 无正文时退化成角色提示', () => {
    expect(summarize({ id: 'm', type: 'message', message: { role: 'assistant' } })).toBe(
      '（assistant 无正文）',
    )
  })

  it('非 message 类型给出可读摘要', () => {
    expect(summarize({ id: 't', type: 'model_change', modelId: 'gpt' })).toBe('模型 → gpt')
    expect(summarize({ id: 'u', type: 'usage' })).toBe('用量记录（usage）')
  })

  it('未知类型也能兜住，不抛异常', () => {
    expect(summarize({ id: 'z', type: 'whatever' })).toBe('whatever（z）')
    // 完全空的输入走「未知类型 + 空 id」的兜底分支，不能抛异常。
    expect(summarize(null)).toBe('unknown（）')
  })
})
