import { describe, expect, it } from 'vitest'
import {
  describeConnectorError,
  emptyInput,
  STATE_TEXT,
  TRANSPORT_TEXT,
  validateServerName,
  type ConnectorSummary,
} from '@/composables/useConnectors'

/** 状态与传输的展示文案必须与 Rust 的 kebab-case 序列化一一对应，否则 UI 会显示 undefined。 */
describe('连接器状态与传输文案', () => {
  it('四个状态都有中文文案，且不与原始枚举值混淆', () => {
    expect(STATE_TEXT).toEqual({
      discovering: '握手中',
      ready: '已连接',
      offline: '连接异常',
      disabled: '已停用',
    })
    // 断言的恰恰是「传输值不会混进状态表」，所以这里必须绕过 ConnectorState 的字面量类型。
    expect((STATE_TEXT as Record<string, string | undefined>)['streamable-http']).toBeUndefined()
  })

  it('传输协议文案覆盖两种取值', () => {
    expect(TRANSPORT_TEXT.stdio).toBe('stdio 子进程')
    expect(TRANSPORT_TEXT['streamable-http']).toBe('Streamable HTTP')
  })
})

describe('服务标识校验', () => {
  it('空、纯空白、纯分隔符一律拒绝', () => {
    expect(validateServerName('')).toBe('不能为空')
    expect(validateServerName('   ')).toBe('不能为空')
    // 后端 sanitize 会把首尾分隔符裁掉，全是分隔符的结果就是空串，必须前端就拦住。
    expect(validateServerName('---')).toBe('至少要包含一个字母或数字')
    expect(validateServerName('___')).toBe('至少要包含一个字母或数字')
  })

  it('只接受字母数字与 - _ ，长度上限 32', () => {
    expect(validateServerName('github')).toBeNull()
    expect(validateServerName('my_server-2')).toBeNull()
    expect(validateServerName('github.com')).toBe('只能包含字母、数字、- 和 _')
    expect(validateServerName('github mcp')).toBe('只能包含字母、数字、- 和 _')
    expect(validateServerName('a'.repeat(33))).toBe('不能超过 32 个字符')
  })
})

describe('连接器错误码翻译', () => {
  const cases: Array<[string, string]> = [
    ['connector/title-required', '连接器名称不能为空'],
    ['connector/server-name-conflict: github', '该服务标识已被占用，工具命名空间不能重名'],
    ['connector/command-required', 'stdio 传输必须填写启动命令'],
    ['connector/url-invalid', 'URL 必须以 http:// 或 https:// 开头'],
    ['connector/not-found: c1', '连接器不存在，可能已被删除'],
    ['connector/disabled: c1', '该连接器已停用，无法选中'],
    ['connector/not-ready: c1', '该连接器还没握手成功，暂时不能选中'],
    ['connector/selection-limit-exceeded（上限 32）', '单个会话最多选 32 个连接器'],
  ]

  for (const [code, text] of cases) {
    it(`${code} → ${text}`, () => {
      expect(describeConnectorError({ message: `invoke failed: ${code}` })).toBe(text)
    })
  }

  it('未知错误与专家域口径一致：回退到兜底文案', () => {
    expect(describeConnectorError(new Error('boom'), '操作失败')).toBe('操作失败')
    expect(describeConnectorError(new Error('boom'))).toBe('操作失败')
  })

  it('带上 id 的错误码仍能被识别（前缀匹配而不是全等）', () => {
    expect(describeConnectorError({ message: 'connector/not-ready: c1' })).toBe(
      '该连接器还没握手成功，暂时不能选中',
    )
  })
})

describe('新建表单初值', () => {
  it('默认走 stdio，字符串字段给空串而不是 undefined', () => {
    const form = emptyInput()
    expect(form.transport).toBe('stdio')
    expect(form.title).toBe('')
    expect(form.command).toBe('')
    expect(form.args).toEqual([])
    expect(form.url).toBe('')
    expect(form.authorization_token).toBe('')
  })
})

describe('摘要结构', () => {
  it('工具名与计数一致，诊断字段可缺省', () => {
    const summary = {
      id: 'c1',
      title: 'GitHub',
      description: '',
      server_name: 'github',
      transport: 'stdio',
      enabled: true,
      state: 'ready',
      tool_names: ['mcp__github__search_code'],
      tool_count: 1,
    } as ConnectorSummary
    expect(summary.tool_count).toBe(summary.tool_names.length)
    // 后端对诊断字段是 skip_serializing_if，前端必须能接受它不存在。
    expect(summary.diagnostic).toBeUndefined()
  })
})
