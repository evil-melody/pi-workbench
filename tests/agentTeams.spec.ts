import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import teamsExtension from '../src-tauri/extensions/agent-teams'

/**
 * 团队定义与调度前的防线：真实读写 `<PI_CODING_AGENT_DIR>/.pi/teams`。
 * 这里不跑成员子进程（无 pi），只验证创建校验、悬空引用拦截、记录口径。
 */
const dirs: string[] = []
const tools = new Map<string, (id: string, args: unknown) => Promise<any>>()

function boot() {
  tools.clear()
  teamsExtension({
    registerTool: (def: { name: string; execute: (id: string, args: unknown) => Promise<any> }) => {
      tools.set(def.name, def.execute)
    },
    registerCommand: () => {},
    setActiveTools: () => {},
  })
}

function call(name: string, args: unknown) {
  return tools.get(name)!('t', args)
}

let prevDir: string | undefined

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-teams-'))
  dirs.push(base)
  prevDir = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = base
  boot()
})

afterEach(() => {
  if (prevDir === undefined) delete process.env.PI_CODING_AGENT_DIR
  else process.env.PI_CODING_AGENT_DIR = prevDir
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function writeExpert(id: string, name: string) {
  const dir = path.join(process.env.PI_CODING_AGENT_DIR!, 'experts')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${id}.draft.json`),
    JSON.stringify({ definition: { name, role: '审查' } }),
  )
}

describe('团队创建校验', () => {
  it('空名 / 空成员 / 牵头人不在成员里都拦下', async () => {
    expect((await call('team_create', { name: '', members: ['a'] })).content).toContain('name')
    expect((await call('team_create', { name: 'T', members: [] })).content).toContain('至少 1')
    expect(
      (await call('team_create', { name: 'T', members: ['a'], lead: 'b' })).content,
    ).toContain('lead')
  })

  it('成员去重，默认牵头第一位，失败策略默认 stop', async () => {
    const res = await call('team_create', { name: 'T', members: ['e:a', 'e:a', 'e:b'] })
    expect(res.details.members).toEqual(['e:a', 'e:b'])
    expect(res.details.lead).toBe('e:a')
    expect(res.details.on_failure).toBe('stop')
    expect(fs.existsSync(path.join(process.env.PI_CODING_AGENT_DIR!, '.pi', 'teams'))).toBe(true)
  })
})

describe('调度前防线', () => {
  it('团队不存在时返回可用团队 id', async () => {
    const res = await call('team_dispatch', { team_id: 'nope', task: 'x' })
    expect(res.content).toContain('不存在')
    expect(res.details.available).toEqual([])
  })

  it('成员引用已删除专家：拒绝调度并列出缺失 id', async () => {
    writeExpert('alive', '在岗专家')
    const created = await call('team_create', { name: 'T', members: ['e:alive', 'e:gone'] })
    const res = await call('team_dispatch', { team_id: created.details.id, task: 'x' })
    expect(res.content).toContain('已不存在')
    expect(res.content).toContain('gone')
    expect(res.details.dangling).toEqual(['gone'])
  })

  it('黑板文件不会被当成团队', async () => {
    const dir = path.join(process.env.PI_CODING_AGENT_DIR!, '.pi', 'teams')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'abc-blackboard.json'), JSON.stringify([{ member: 'e:a' }]))
    const res = await call('team_status', { team_id: 'abc' })
    expect(res.details.available).toEqual([])
  })

  it('已删除团队（<id>.deleted.json）不再可调度，运行日志仍保留', async () => {
    const created = await call('team_create', { name: '旧队', members: ['s:写手'] })
    const id = created.details.id
    const dir = path.join(process.env.PI_CODING_AGENT_DIR!, '.pi', 'teams')
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), '{"type":"run_end"}\n')
    fs.renameSync(path.join(dir, `${id}.json`), path.join(dir, `${id}.deleted.json`))

    const status = await call('team_status', { team_id: id })
    expect(status.details.available).toEqual([])
    expect(status.content).toContain('不存在')
    // 软删除只动定义；历史日志留在原地，Rust 侧 agent_team_runs 仍可按 id 读取。
    expect(fs.existsSync(path.join(dir, `${id}.jsonl`))).toBe(true)
  })

  it('调度次数按 run_end 统计，不数日志行', async () => {
    const created = await call('team_create', { name: 'T', members: ['s:写手'] })
    const log = path.join(process.env.PI_CODING_AGENT_DIR!, '.pi', 'teams', `${created.details.id}.jsonl`)
    fs.writeFileSync(
      log,
      [
        { runId: 'r1', type: 'member_start', member: 's:写手' },
        { runId: 'r1', type: 'member_end', member: 's:写手', ok: true },
        { runId: 'r1', type: 'run_end' },
        { runId: 'r2', type: 'member_start', member: 's:写手' },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n',
    )
    const res = await call('team_status', { team_id: created.details.id })
    expect(res.details.dispatches).toBe(1)
    expect(res.content).toContain('调度次数：1')
  })
})
