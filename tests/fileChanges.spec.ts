import { describe, expect, it } from 'vitest'
import {
  diffLines,
  extractFileChange,
  summarizeChange,
  type PiFileChange,
} from '@/utils/fileChanges'

/**
 * G2：文件改动提取。事件形状以内核实证为准：
 * - `tool_execution_start`：`{ toolName, args, toolCallId }`（agent-session.js 转发的 agent 事件）
 * - `message_update` 内层 `toolcall_end`：`{ toolCall: { id, name, arguments } }`（pi-ai 协议）
 * edit/write 参数形状以内核 schema 为准：edit={path,edits:[{oldText,newText}]}、write={path,content}。
 */
describe('extractFileChange · edit', () => {
  it('解析标准 edit 参数', () => {
    const c = extractFileChange('edit', {
      path: 'src/a.ts',
      edits: [
        { oldText: 'foo', newText: 'bar' },
        { oldText: 'baz', newText: 'qux' },
      ],
    }, 'call-1')
    expect(c).not.toBeNull()
    expect(c!.tool).toBe('edit')
    expect(c!.path).toBe('src/a.ts')
    expect(c!.edits).toHaveLength(2)
    expect(c!.content).toBeNull()
    expect(c!.id).toBe('call-1')
  })

  it('工具名大小写/空白不敏感', () => {
    expect(
      extractFileChange(' Edit ', { path: 'a', edits: [{ oldText: 'x', newText: 'y' }] })?.tool,
    ).toBe('edit')
    expect(extractFileChange('WRITE', { path: 'a', content: 'x' })?.tool).toBe('write')
  })

  it('单条 edit 对象（非数组）也能解析', () => {
    const c = extractFileChange('edit', { path: 'a', edits: { oldText: 'x', newText: 'y' } })
    expect(c?.edits).toEqual([{ oldText: 'x', newText: 'y' }])
  })

  it('edits 是 JSON 字符串时先解析（内核见过模型这么发）', () => {
    const c = extractFileChange('edit', {
      path: 'a',
      edits: JSON.stringify([{ oldText: 'x', newText: 'y' }]),
    })
    expect(c?.edits).toHaveLength(1)
  })

  it('edits 缺字段的脏条目过滤掉，不全量丢弃', () => {
    const c = extractFileChange('edit', {
      path: 'a',
      edits: [{ oldText: 'x', newText: 'y' }, { oldText: 1 }, null, 'nope'],
    })
    expect(c?.edits).toEqual([{ oldText: 'x', newText: 'y' }])
  })
})

describe('extractFileChange · write', () => {
  it('解析标准 write 参数', () => {
    const c = extractFileChange('write', { path: 'src/new.ts', content: 'hello\nworld' }, 'call-2')
    expect(c).not.toBeNull()
    expect(c!.tool).toBe('write')
    expect(c!.content).toBe('hello\nworld')
    expect(c!.edits).toEqual([])
  })

  it('空 content 也是合法写入', () => {
    expect(extractFileChange('write', { path: 'a', content: '' })?.content).toBe('')
  })
})

describe('extractFileChange · 拒绝', () => {
  it('非 edit/write 工具返回 null', () => {
    expect(extractFileChange('bash', { command: 'ls' })).toBeNull()
    expect(extractFileChange('read', { path: 'a' })).toBeNull()
    expect(extractFileChange('grep', { path: 'a' })).toBeNull()
  })

  it('参数不完整返回 null（path 缺失/非字符串）', () => {
    expect(extractFileChange('edit', { edits: [] })).toBeNull()
    expect(extractFileChange('edit', { path: 42, edits: [] })).toBeNull()
    expect(extractFileChange('write', { path: 'a' })).toBeNull()
    expect(extractFileChange('write', { content: 'x' })).toBeNull()
  })

  it('edit 的 edits 全脏时返回 null', () => {
    expect(extractFileChange('edit', { path: 'a', edits: [{ nope: 1 }] })).toBeNull()
  })

  it('args 不是对象 / 工具名为空都返回 null', () => {
    expect(extractFileChange('edit', 'string')).toBeNull()
    expect(extractFileChange('edit', null)).toBeNull()
    expect(extractFileChange('', { path: 'a', content: 'x' })).toBeNull()
  })

  it('callId 缺失时按 tool:path 生成稳定 id（去重仍可用）', () => {
    const a = extractFileChange('edit', { path: 'a', edits: [{ oldText: 'x', newText: 'y' }] })
    const b = extractFileChange('edit', { path: 'a', edits: [{ oldText: 'x', newText: 'y' }] })
    expect(a?.id).toBe(b?.id)
    expect(a?.id).toContain('edit:a')
  })
})

describe('summarizeChange', () => {
  it('edit 报处数', () => {
    const c = extractFileChange('edit', {
      path: 'a',
      edits: [
        { oldText: 'x', newText: 'y' },
        { oldText: 'p', newText: 'q' },
      ],
    })!
    expect(summarizeChange(c)).toBe('2 处替换')
  })

  it('write 报行数', () => {
    const c = extractFileChange('write', { path: 'a', content: 'l1\nl2\nl3' })!
    expect(summarizeChange(c)).toBe('3 行')
  })

  it('空 write 报 0 行', () => {
    const c = extractFileChange('write', { path: 'a', content: '' })!
    expect(summarizeChange(c)).toBe('0 行')
  })
})

describe('PiFileChange 类型可用性', () => {
  it('接口字段手工构造不报错（tsc 层面由 vue-tsc 把关）', () => {
    const c: PiFileChange = {
      id: 'x',
      tool: 'write',
      path: 'p',
      edits: [],
      content: 'c',
    }
    expect(summarizeChange(c)).toBe('1 行')
  })
})

describe("diffLines", () => {
  it("edit：替换对输出 -/+ 行，按序排列", () => {
    const c = extractFileChange("edit", {
      path: "a",
      edits: [
        { oldText: "old1", newText: "new1" },
        { oldText: "old2", newText: "new2" },
      ],
    })!
    expect(diffLines(c)).toEqual([
      { kind: "del", text: "old1" },
      { kind: "add", text: "new1" },
      { kind: "del", text: "old2" },
      { kind: "add", text: "new2" },
    ])
  })

  it("edit：多行 oldText/newText 按行拆开", () => {
    const c = extractFileChange("edit", {
      path: "a",
      edits: [{ oldText: "l1\nl2", newText: "m1\nm2\nm3" }],
    })!
    const lines = diffLines(c)
    expect(lines).toHaveLength(5)
    expect(lines[0]).toEqual({ kind: "del", text: "l1" })
    expect(lines[2]).toEqual({ kind: "add", text: "m1" })
  })

  it("write：整文件内容全部计为新增", () => {
    const c = extractFileChange("write", { path: "a", content: "x\ny" })!
    expect(diffLines(c)).toEqual([
      { kind: "add", text: "x" },
      { kind: "add", text: "y" },
    ])
  })

  it("空 write 给出一行空新增", () => {
    const c = extractFileChange("write", { path: "a", content: "" })!
    expect(diffLines(c)).toEqual([{ kind: "add", text: "" }])
  })
})
