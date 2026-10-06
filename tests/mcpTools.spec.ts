import { describe, expect, it } from 'vitest'
import { parseToolName, parseToolDescription } from '../src/utils/mcpTools'

describe('parseToolName', () => {
  it('returns name from plain MCP tool', () => {
    expect(parseToolName({ name: 'read_file', description: 'x' })).toBe('read_file')
  })

  it('returns function name from OpenAI-style wrapper', () => {
    expect(parseToolName({ function: { name: 'edit_file', description: 'y' } })).toBe('edit_file')
  })

  it('falls back to unknown', () => {
    expect(parseToolName({})).toBe('unknown')
    expect(parseToolName(null)).toBe('unknown')
  })

  it('handles string input', () => {
    expect(parseToolName('bash')).toBe('bash')
  })
})

describe('parseToolDescription', () => {
  it('returns plain description', () => {
    expect(parseToolDescription({ name: 'a', description: 'read a file' })).toBe('read a file')
  })

  it('returns function description', () => {
    expect(parseToolDescription({ function: { description: 'edit a file' } })).toBe('edit a file')
  })

  it('returns empty string for null', () => {
    expect(parseToolDescription(null)).toBe('')
  })
})
