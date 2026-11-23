import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import teamsExtension, { parseMemberOutput } from '../src-tauri/extensions/agent-teams'
import roleInjectExtension from '../src-tauri/extensions/role-inject'

/**
 * 团队定义与调度前的防线：真实读写 `<PI_CODING_AGENT_DIR>/.pi/teams`。
 * 这里不跑成员子进程（无 pi），只验证创建校验、悬空引用拦截、记录口径。
 */
const dirs: string[] = []
const tools = new Map<string, (id: string, args: unknown) => Promise<any>>()
const commands = new Map<string, (arg: string, ctx: any) => Promise<any>>()

function boot() {
  tools.clear()
  commands.clear()
  teamsExtension({
    registerTool: (def: { name: string; execute: (id: string, args: unknown) => Promise<any> }) => {
      tools.set(def.name, def.execute)
    },
    registerCommand: (
      name: string,
      def: { handler: (arg: string, ctx: any) => Promise<any> },
    ) => {
      commands.set(name, def.handler)
    },
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
  it('/team dispatch 命令走同一条真实调度路径', async () => {
    writeExpert('alive', '在岗专家')
    const created = await call('team_create', { name: '召唤测试队', members: ['e:alive'] })
    const notes: string[] = []
    await commands.get('team')!(`dispatch ${created.details.id} 做点事`, {
      ui: { notify: (msg: string) => notes.push(msg) },
    })
    expect(notes[0]).toContain('召唤测试队')
  })

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

describe('team_dispatch 后台派发', () => {
  it('真实执行时立即返回运行号，成员在后台跑完', async () => {
    if (process.platform === 'win32') return
    const base = process.env.PI_CODING_AGENT_DIR!
    const bin = path.join(base, 'bin')
    fs.mkdirSync(bin, { recursive: true })
    const exe = path.join(bin, 'pi')
    fs.writeFileSync(
      exe,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1; exit 0; fi\ncat >/dev/null\nsleep 2\necho \'{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ok"}]}}\'\n',
      { mode: 0o755 },
    )
    const oldPath = process.env.PATH
    process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`
    try {
      writeExpert('alive', '在岗专家')
      const created = await call('team_create', { name: '后台队', members: ['e:alive'] })
      const started = Date.now()
      const res = await call('team_dispatch', { team_id: created.details.id, task: '做点事' })
      expect(Date.now() - started).toBeLessThan(3000)
      expect(res.details.async).toBe(true)
      expect(res.details.run_id).toBeTruthy()
      const log = path.join(base, '.pi', 'teams', `${created.details.id}.jsonl`)
      expect(fs.readFileSync(log, 'utf8')).toContain('"type":"run_start"')
      expect(fs.readFileSync(log, 'utf8')).not.toContain('"type":"run_end"')
      for (let i = 0; i < 150 && !fs.readFileSync(log, 'utf8').includes('"type":"run_end"'); i++) {
        await new Promise((r) => setTimeout(r, 20))
      }
      expect(fs.readFileSync(log, 'utf8')).toContain('"type":"run_end"')
    } finally {
      process.env.PATH = oldPath
    }
  })
})

describe('team_dispatch 缺参与幂等', () => {
  it('模型只给 task 时，单团队自动兜底（不再缺参失败→重试风暴）', async () => {
    writeExpert('alive', '在岗专家')
    await call('team_create', { name: '唯一队', members: ['e:alive'] })
    const res = await call('team_dispatch', { task: '做点事' })
    // 关键是 execute 跑到了（派出成功），而不是被内核 required 拦下报失败。
    expect(res.content).toContain('已派出团队')
    expect(res.details.run_id).toBeTruthy()
  })

  it('同一团队同一任务短窗口内只派一次，重复返回原运行号', async () => {
    writeExpert('alive', '在岗专家')
    const created = await call('team_create', { name: '幂等队', members: ['e:alive'] })
    const first = await call('team_dispatch', { team_id: created.details.id, task: '同一件事' })
    const again = await call('team_dispatch', { team_id: created.details.id, task: '同一件事' })
    expect(again.details.duplicate).toBe(true)
    expect(again.details.run_id).toBe(first.details.run_id)
    expect(again.content).toContain('未重复派出')
  })
})

describe('队长提示词', () => {
  it('代码小队队长拿到本仓真调度入口', () => {
    const base = process.env.PI_CODING_AGENT_DIR!
    const roleDir = path.join(base, '.pi', 'roles')
    fs.mkdirSync(roleDir, { recursive: true })
    fs.writeFileSync(
      path.join(roleDir, 'current.md'),
      '<!-- role: code-crew-team-lead | Horizon -->\n你是代码小队队长。\n\n## 团队协作机制（铁律）\n只调度不亲自写。',
    )
    let handler: ((ctx: any) => void) | undefined
    roleInjectExtension({
      on: (name: string, fn: (ctx: any) => void) => {
        if (name === 'before_agent_start') handler = fn
      },
    })
    const ctx = { systemPromptOptions: { appendSystemPrompt: '' } }
    const oldCwd = process.cwd()
    process.chdir(base)
    try {
      handler!(ctx)
    } finally {
      process.chdir(oldCwd)
    }
    expect(ctx.systemPromptOptions.appendSystemPrompt).toContain('team_create')
    expect(ctx.systemPromptOptions.appendSystemPrompt).toContain('team_dispatch')
    expect(ctx.systemPromptOptions.appendSystemPrompt).toContain('没有 Agent 工具')
  })
})

/**
 * Pi json 模式解析：信封形状以 pi 0.87.1 的 docs/json.md 为准。
 * 回归 2026-11-22 生产事故——delta 嵌套在 assistantMessageEvent 里，
 * 扁平 `ev.delta` 全部 miss，成员烧了 45k token 被判「无输出」，
 * stop 策略中断全队。
 */
describe('parseMemberOutput · pi json 事件流', () => {
  it('嵌套 text_delta 累加，text_end 权威替换，message_end 定稿收编', () => {
    const stream = [
      '{"type":"session","version":3,"id":"x","timestamp":"t","cwd":"/p"}',
      '{"type":"agent_start"}',
      '{"type":"message_start","message":{"role":"assistant","content":[],"stopReason":"pending"}}',
      '{"type":"message_update","usage":{"totalTokens":101},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello "}}',
      '{"type":"message_update","usage":{"totalTokens":202},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"wor"}}',
      // text_end 带整块权威 content：替换累计的 delta，不能拼接。
      '{"type":"message_update","usage":{"totalTokens":202},"assistantMessageEvent":{"type":"text_end","contentIndex":0,"content":"Hello world!"}}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Hello world!"}],"stopReason":"stop","usage":{"totalTokens":202}}}',
      '{"type":"agent_end","messages":[],"willRetry":false}',
    ].join('\n')
    const parsed = parseMemberOutput(stream)
    expect(parsed.text).toBe('Hello world!')
    expect(parsed.tokens).toBe(202)
    expect(parsed.error).toBeUndefined()
  })

  it('多文本块按 contentIndex 排序拼接，thinking/toolcall 不污染正文', () => {
    const stream = [
      '{"type":"message_update","usage":{"totalTokens":50},"assistantMessageEvent":{"type":"thinking_delta","contentIndex":0,"thinking":"内部推理"}}',
      '{"type":"message_update","usage":{"totalTokens":50},"assistantMessageEvent":{"type":"text_delta","contentIndex":2,"delta":"第二段"}}',
      '{"type":"message_update","usage":{"totalTokens":50},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"第一段"}}',
      '{"type":"message_update","usage":{"totalTokens":50},"assistantMessageEvent":{"type":"toolcall_delta","contentIndex":1,"delta":"{\\"command\\""}}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"内部推理"},{"type":"toolCall","id":"c1","name":"bash","arguments":{}},{"type":"text","text":"第一段"},{"type":"text","text":"第二段"}],"stopReason":"toolUse","usage":{"totalTokens":50}}}',
    ].join('\n')
    const parsed = parseMemberOutput(stream)
    expect(parsed.text).toBe('第一段第二段')
    expect(parsed.tokens).toBe(50)
  })

  it('取消场景：无 message_end 时流式缓冲就是 partial 正文', () => {
    const stream = [
      '{"type":"message_update","usage":{"totalTokens":300},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"已经写了一半"}}',
      '{"type":"message_update","usage":{"totalTokens":300},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"的报告"}}',
    ].join('\n')
    const parsed = parseMemberOutput(stream)
    expect(parsed.text).toBe('已经写了一半的报告')
    expect(parsed.tokens).toBe(300)
  })

  it('错误轮（429）：退出码 0 也要透出 errorMessage，不再误报「无输出」', () => {
    const stream = [
      '{"type":"message_update","usage":{"totalTokens":45191},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"\\n\\n"}}',
      '{"type":"message_end","message":{"role":"assistant","content":[],"stopReason":"error","errorMessage":"OpenAI API error (429): rate limit","usage":{"totalTokens":0}}}',
    ].join('\n')
    const parsed = parseMemberOutput(stream)
    expect(parsed.error).toContain('429')
    // 占位换行不算正文：text 空 + error 有值 → 调度侧报真因。
    expect(parsed.text).toBe('')
    expect(parsed.tokens).toBe(45191)
  })

  it('user 消息的 message_end 不收编正文，只认 assistant', () => {
    const stream = [
      '{"type":"message_start","message":{"role":"user","content":"任务提示词"}}',
      '{"type":"message_end","message":{"role":"user","content":"任务提示词"}}',
      '{"type":"message_update","usage":{"totalTokens":10},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"真答复"}}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"真答复"}],"stopReason":"stop","usage":{"totalTokens":10}}}',
    ].join('\n')
    const parsed = parseMemberOutput(stream)
    expect(parsed.text).toBe('真答复')
  })

  it('非 JSON 行原样返回（老版本纯文本回落）', () => {
    const parsed = parseMemberOutput('pure text\nsecond line\n')
    expect(parsed.text).toBe('pure text\nsecond line')
    expect(parsed.tokens).toBe(0)
  })
})
