import { describe, expect, it } from 'vitest'
import { suggestFrom, topicFrom } from '../src-tauri/extensions/agent-suggest'
import { teamDispatchInstruction } from '../src/utils/teamDispatch'

describe('M5 推荐主题抽取', () => {
  it('原文直接抽主题', () => {
    expect(topicFrom('  修复登录页样式  ')).toBe('修复登录页样式')
    expect(topicFrom('')).toBe(null)
  })

  it('派遣指令与 preamble 不进主题（截图：继续You are the team lead...）', () => {
    const body = teamDispatchInstruction('team-1', '检查一下当前项目的问题')
    const withPreamble = `项目上下文\n\n---\n\n${body}`
    expect(topicFrom(withPreamble)).toBe('检查一下当前项目的问题')
    expect(suggestFrom(withPreamble)[0]).toContain('检查一下当前项目的问题')
    expect(suggestFrom(withPreamble).join('')).not.toContain('team lead')
  })
})
