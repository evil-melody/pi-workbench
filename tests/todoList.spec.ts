import { describe, expect, it } from 'vitest'
import { parseTodoList, type TodoItem } from '@/utils/todoList'

function msg(id: string, text: string) {
  return { id, role: 'assistant' as const, text, streaming: false }
}

describe('parseTodoList', () => {
  it('解析 markdown 复选框列表', () => {
    const todo = parseTodoList([msg('m1', '计划：\n- [ ] 第一步\n- [x] 第二步')])
    expect(todo.map((t) => t.text)).toEqual(['第一步', '第二步'])
    expect(todo.map((t) => t.done)).toEqual([false, true])
  })

  it('支持 * 与有序列表符号', () => {
    const todo = parseTodoList([msg('m1', '* [ ] a\n1. [x] b')])
    expect(todo.map((t) => t.text)).toEqual(['a', 'b'])
    expect(todo.map((t) => t.done)).toEqual([false, true])
  })

  it('去掉行内多余空白并跳过无内容项', () => {
    const todo = parseTodoList([msg('m1', '- [ ]   空格任务   \n- [ ]')])
    expect(todo).toHaveLength(1)
    expect(todo[0].text).toBe('空格任务')
  })

  it('只扫描 assistant 消息', () => {
    const todo = parseTodoList([
      { id: 'u1', role: 'user', text: '- [ ] 用户写的', streaming: false },
    ])
    expect(todo).toHaveLength(0)
  })

  it('同一条消息内重复任务只保留一条', () => {
    const todo = parseTodoList([msg('m1', '- [ ] 重复\n- [ ] 重复')])
    expect(todo).toHaveLength(1)
  })

  it('不同消息间同名任务按来源分别保留', () => {
    const todo = parseTodoList([
      msg('m1', '- [ ] 同名'),
      msg('m2', '- [ ] 同名'),
    ])
    expect(todo).toHaveLength(2)
    expect(todo[1].messageId).toBe('m2')
  })

  it('跳过流式输出中未闭合的复选框行', () => {
    const todo = parseTodoList([{ ...msg('m1', '- [x] 完成'), streaming: true }])
    expect(todo).toHaveLength(0)
  })

  it('无任务清单时返回空数组', () => {
    expect(parseTodoList([msg('m1', '这只是普通回复')])).toEqual([])
    expect(parseTodoList([])).toEqual([])
  })
})
