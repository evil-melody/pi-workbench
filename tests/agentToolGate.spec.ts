import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  auditExpertDenial,
  expertGateDecision,
  readExpertPolicy,
} from '../src-tauri/extensions/agent-tool-gate'
import gateExtension from '../src-tauri/extensions/agent-tool-gate'

/**
 * 专家权限的硬闸：策略文件由桥在发起运行前写入项目 `.pi/policy/expert.json`。
 * 这里用真实临时目录验证「读策略 → 越界拦截 → 审计留痕」整条链路。
 */
const dirs: string[] = []

function project(policy: unknown | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-expert-gate-'))
  dirs.push(dir)
  if (policy) {
    fs.mkdirSync(path.join(dir, '.pi', 'policy'), { recursive: true })
    fs.writeFileSync(
      path.join(dir, '.pi', 'policy', 'expert.json'),
      JSON.stringify(policy),
    )
  }
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('专家工具门', () => {
  it('没有策略文件 = 不限制', () => {
    const prevExpertId = process.env.PI_EXPERT_ID
    delete process.env.PI_EXPERT_ID
    try {
      const cwd = project(null)
      expect(readExpertPolicy(cwd)).toBeNull()
      expect(expertGateDecision(null, 'bash', { command: 'rm -rf /' })).toBeNull()
    } finally {
      if (prevExpertId === undefined) delete process.env.PI_EXPERT_ID
      else process.env.PI_EXPERT_ID = prevExpertId
    }
  })

  it('白名单外的工具被拦下，白名单内放行', () => {
    const prevExpertId = process.env.PI_EXPERT_ID
    delete process.env.PI_EXPERT_ID
    try {
      const cwd = project({
        expertId: 'reviewer',
        name: '代码评审专家',
        allowedTools: ['read', 'grep'],
        deniedPatterns: [],
      })
      const policy = readExpertPolicy(cwd)
      expect(policy).not.toBeNull()

    const denied = expertGateDecision(policy, 'bash', { command: 'echo hi' })
    expect(denied?.block).toBe(true)
    expect(denied?.reason).toContain('未授权工具 bash')
    expect(denied?.reason).toContain('代码评审专家')
      expect(expertGateDecision(policy, 'read', { path: 'a.ts' })).toBeNull()
    } finally {
      if (prevExpertId === undefined) delete process.env.PI_EXPERT_ID
      else process.env.PI_EXPERT_ID = prevExpertId
    }
  })

  it('拒绝模式命中 bash 命令（大小写不敏感）', () => {
    const prevExpertId = process.env.PI_EXPERT_ID
    delete process.env.PI_EXPERT_ID
    try {
      const cwd = project({
        expertId: 'reviewer',
        allowedTools: ['bash'],
        deniedPatterns: ['git push', 'npm publish'],
      })
      const policy = readExpertPolicy(cwd)
      const hit = expertGateDecision(policy, 'bash', { command: 'git PUSH origin main' })
      expect(hit?.block).toBe(true)
      expect(hit?.reason).toContain('git push')
      expect(expertGateDecision(policy, 'bash', { command: 'git status' })).toBeNull()
    } finally {
      if (prevExpertId === undefined) delete process.env.PI_EXPERT_ID
      else process.env.PI_EXPERT_ID = prevExpertId
    }
  })

  it('越界被拦后写审计行（真实用例：允许 read，bash 被拒）', () => {
    const prevExpertId = process.env.PI_EXPERT_ID
    delete process.env.PI_EXPERT_ID
    try {
      const cwd = project({
        expertId: 'reviewer',
        name: '代码评审专家',
        allowedTools: ['read'],
        deniedPatterns: [],
      })
      const policy = readExpertPolicy(cwd)!
      const before = expertGateDecision(policy, 'bash', { command: 'ls' })
    expect(before?.block).toBe(true)
      auditExpertDenial(cwd, policy, 'bash', 'ls')

      const audit = fs
      .readFileSync(path.join(cwd, '.pi', 'policy', 'expert-audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      kind: 'expert_denied',
      expertId: 'reviewer',
      tool: 'bash',
      detail: 'ls',
    })
    } finally {
      if (prevExpertId === undefined) delete process.env.PI_EXPERT_ID
      else process.env.PI_EXPERT_ID = prevExpertId
    }
  })

  it('gate_status 永远放行，便于确认策略是否生效', () => {
    const policy = {
      expertId: 'reviewer',
      allowedTools: ['read'],
      deniedPatterns: [],
    }
    expect(expertGateDecision(policy, 'gate_status', {})).toBeNull()
  })

  it('团队成员按 PI_EXPERT_ID 读专家定义：无策略文件也拦越界工具', () => {
    const base = project(null)
    fs.mkdirSync(path.join(base, 'experts'), { recursive: true })
    fs.writeFileSync(
      path.join(base, 'experts', 'reviewer.draft.json'),
      JSON.stringify({
        definition: {
          name: '评审员',
          allowed_tools: ['read'],
          denied_patterns: ['git push'],
        },
      }),
    )
    const prevDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = base
    process.env.PI_EXPERT_ID = 'reviewer'
    try {
      const policy = readExpertPolicy(project(null))
      expect(policy?.expertId).toBe('reviewer')
      expect(expertGateDecision(policy, 'read', { path: 'a.ts' })).toBeNull()
      const denied = expertGateDecision(policy, 'bash', { command: 'ls' })
      expect(denied?.block).toBe(true)
      // 白名单内也受拒绝模式约束。
      expect(
        expertGateDecision({ ...policy!, allowedTools: ['bash'] }, 'bash', { command: 'git PUSH' })
          ?.block,
      ).toBe(true)
    } finally {
      delete process.env.PI_EXPERT_ID
      if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = prevDir
    }
  })

  it('团队成员显式注入空 PI_EXPERT_ID：不吃项目策略文件', () => {
    const cwd = project({
      expertId: 'stale',
      name: '上一次交互运行的专家',
      allowedTools: ['read'],
      deniedPatterns: [],
    })
    const prev = process.env.PI_EXPERT_ID
    process.env.PI_EXPERT_ID = ''
    try {
      expect(readExpertPolicy(cwd)).toBeNull()
    } finally {
      if (prev === undefined) delete process.env.PI_EXPERT_ID
      else process.env.PI_EXPERT_ID = prev
    }
  })

  it('团队成员引用的专家定义缺失：返回空策略，不套用别的专家', () => {
    const prevDir = process.env.PI_CODING_AGENT_DIR
    process.env.PI_CODING_AGENT_DIR = project(null)
    process.env.PI_EXPERT_ID = 'deleted-expert'
    try {
      expect(readExpertPolicy(project(null))).toBeNull()
    } finally {
      delete process.env.PI_EXPERT_ID
      if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR
      else process.env.PI_CODING_AGENT_DIR = prevDir
    }
  })

  it('走真实 tool_call 处理器：越界被拦并落审计，白名单内放行', async () => {
    const cwd = project({
      expertId: 'reviewer',
      name: '代码评审专家',
      allowedTools: ['read'],
      deniedPatterns: [],
    })
    let handler: ((event: unknown, ctx: unknown) => Promise<unknown>) | null = null
    gateExtension({
      on: (name: string, fn: typeof handler) => { if (name === 'tool_call') handler = fn },
      registerTool: () => {},
      setActiveTools: () => {},
    })
    expect(handler).not.toBeNull()

    const prev = process.cwd()
    process.chdir(cwd)
    try {
      // 真实越界调用：策略只允许 read，bash 必须被拦下。
      const denied = (await handler!({ toolName: 'bash', input: { command: 'rm -rf build' } }, {})) as
        | { block?: boolean; reason?: string }
        | undefined
      expect(denied?.block).toBe(true)
      expect(denied?.reason).toContain('未授权工具 bash')
      // 白名单内只读工具正常放行（处理器返回 undefined）。
      expect(await handler!({ toolName: 'read', input: { path: 'a.ts' } }, {})).toBeUndefined()
    } finally {
      process.chdir(prev)
    }

    const audit = fs
      .readFileSync(path.join(cwd, '.pi', 'policy', 'expert-audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({
      kind: 'expert_denied',
      expertId: 'reviewer',
      tool: 'bash',
      detail: 'rm -rf build',
    })
  })
})
