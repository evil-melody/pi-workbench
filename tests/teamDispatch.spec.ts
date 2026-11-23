import { describe, expect, it } from 'vitest'
import { teamDispatchInstruction } from '@/utils/teamDispatch'

describe('teamDispatchInstruction', () => {
  it('empty team id returns the task unchanged, no instruction injected', () => {
    expect(teamDispatchInstruction('', 'check the project')).toBe('check the project')
    expect(teamDispatchInstruction('   ', 'check the project')).toBe('check the project')
  })

  it('with an id, asks for the team_dispatch tool rather than the /team command', () => {
    const out = teamDispatchInstruction('abc123', 'check the project')
    expect(out).toContain('team_dispatch tool')
    expect(out).toContain('abc123')
    expect(out).toContain('check the project')
    expect(out).not.toContain('/team dispatch')
  })

  it('forbids the lead from faking member output or calling an Agent tool', () => {
    const out = teamDispatchInstruction('abc123', 'task')
    expect(out).toContain('do not write member results')
    expect(out).toContain('Agent tool')
  })
})
