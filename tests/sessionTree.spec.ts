import { describe, expect, it } from 'vitest'
import {
  canFork,
  flattenTree,
  forkTargetId,
  summarize,
  visibleNodes,
  type FlatNode,
  type PiTreeNode,
} from '@/composables/useSessionTree'

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

describe('visibleNodes（会话树噪音过滤）', () => {
  function flat(overrides: Partial<FlatNode>): FlatNode {
    return {
      id: 'x',
      depth: 0,
      kind: 'message',
      role: 'assistant',
      text: '正文',
      time: '',
      isLeaf: false,
      hasBranch: false,
      ...overrides,
    }
  }

  it('过滤内核自动重试写入的空 assistant 条目', () => {
    const rows = [
      flat({ id: 'u', role: 'user', text: '问题' }),
      flat({ id: 'e1', text: '（assistant 无正文）' }),
      flat({ id: 'a', text: '回答' }),
    ]
    expect(visibleNodes(rows).map((n) => n.id)).toEqual(['u', 'a'])
  })

  it('过滤 context_edit 条目', () => {
    const rows = [
      flat({ id: 'c', kind: 'context_edit', role: undefined }),
      flat({ id: 'a' }),
    ]
    expect(visibleNodes(rows).map((n) => n.id)).toEqual(['a'])
  })

  it('空列表原样返回', () => {
    expect(visibleNodes([])).toEqual([])
  })
})

describe('canFork / forkTargetId（Pi fork 语义对齐）', () => {
  it('只有 user message 条目可分叉（Pi fork position=before 的硬约束）', () => {
    expect(canFork({ id: 'u', depth: 0, kind: 'message', role: 'user', text: '', time: '', isLeaf: false, hasBranch: false })).toBe(true)
    expect(canFork({ id: 'a', depth: 0, kind: 'message', role: 'assistant', text: '', time: '', isLeaf: false, hasBranch: false })).toBe(false)
    expect(canFork({ id: 'm', depth: 0, kind: 'model_change', role: undefined, text: '', time: '', isLeaf: false, hasBranch: false })).toBe(false)
  })

  it('forkTargetId 取最后一条 user message 的 id', () => {
    const rows = [
      { id: 'u1', depth: 0, kind: 'message', role: 'user', text: '1', time: '', isLeaf: false, hasBranch: false } as FlatNode,
      { id: 'a1', depth: 0, kind: 'message', role: 'assistant', text: '2', time: '', isLeaf: false, hasBranch: false } as FlatNode,
      { id: 'u2', depth: 0, kind: 'message', role: 'user', text: '3', time: '', isLeaf: false, hasBranch: false } as FlatNode,
      { id: 'a2', depth: 0, kind: 'message', role: 'assistant', text: '（assistant 无正文）', time: '', isLeaf: false, hasBranch: false } as FlatNode,
    ]
    expect(forkTargetId(rows)).toBe('u2')
  })

  it('没有 user message 时返回 null（分叉按钮禁用）', () => {
    expect(forkTargetId([])).toBeNull()
  })
})
