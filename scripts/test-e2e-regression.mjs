#!/usr/bin/env node
/**
 * B1 + B3 无头端到端回归：stub OpenAI 模型驱动真 pi 内核（rpc 模式）+ 真 gate 扩展。
 *
 * 覆盖：
 * - B1 风险命令批准回路：extension_ui_request → 批准 → 工具真执行（哨兵文件被删）。
 * - B1 风险命令拒绝回路：confirmed:false → 不执行（哨兵文件还在），模型可继续对话。
 * - B1 灾难命令硬闸：rm -rf 无横幅直接 block（哨兵还在），turn 终止。
 * - B3 压缩回路：rpc compact → response 成功返回（摘要由 stub 提供）。
 *
 * 运行：node scripts/test-e2e-regression.mjs
 * 依赖：PATH 上的 pi（真内核）；无网络、无真实 API key——模型是本机 stub。
 */
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const GATE_EXT = path.join(ROOT, 'src-tauri/extensions/agent-tool-gate.ts')
const SCENARIO_TIMEOUT_MS = 90_000

let passed = 0
let failed = 0
function report(name, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** 断言失败时转储事件流，便于定位协议层问题。 */
function dumpEvents(s, limit = 40) {
  for (const e of s.events.slice(0, limit)) {
    console.log('    [event]', JSON.stringify(e).slice(0, 220))
  }
  const err = s.stderrText()
  if (err.trim()) console.log('    [stderr]', err.trim().slice(0, 600))
}

/**
 * Stub OpenAI 兼容服务：首轮返回 tool_call（按剧本），后续轮返回纯文本。
 * script: { toolCall?: {name, args}, text?: string } 数组按调用次数消费。
 * pi 的 openai-completions 客户端只吃 SSE 流式响应（非流式 JSON 会报
 * 「Stream ended without finish_reason」），所以统一回 chat.completion.chunk 流。
 */
function startStubServer(script) {
  let call = 0
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      const step = script[Math.min(call, script.length - 1)]
      call++
      if (process.env.E2E_DEBUG) console.log(`  [stub] 第 ${call} 次调用，剧本步: ${step.toolCall ? 'toolCall' : 'text'}`)
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const chunk = (delta, finish = null) =>
        JSON.stringify({
          id: `chatcmpl-${call}`,
          object: 'chat.completion.chunk',
          model: 'stub-model',
          choices: [{ index: 0, delta, finish_reason: finish }],
        })
      res.write(`data: ${chunk({ role: 'assistant' })}\n\n`)
      if (step.toolCall) {
        res.write(
          `data: ${chunk({
            tool_calls: [
              {
                index: 0,
                id: `call_${call}`,
                type: 'function',
                function: { name: step.toolCall.name, arguments: JSON.stringify(step.toolCall.args) },
              },
            ],
          })}\n\n`)
        res.write(`data: ${chunk({}, 'tool_calls')}\n\n`)
      } else {
        res.write(`data: ${chunk({ content: step.text ?? 'STUB-DONE' })}\n\n`)
        res.write(`data: ${chunk({}, 'stop')}\n\n`)
      }
      // usage 垫高会话体量（compact 的「session too small」按 token 计），末尾 usage 帧。
      res.write(
        `data: ${JSON.stringify({ id: `chatcmpl-${call}`, object: 'chat.completion.chunk', model: 'stub-model', choices: [], usage: { prompt_tokens: 30_000, completion_tokens: 300, total_tokens: 30_300 } })}\n\n`,
      )
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}

/** 跑一个场景：起 stub + pi rpc，执行剧本，收集事件，返回句柄。 */
async function runScenario(name, stubScript, { extensions = [GATE_EXT], noSession = true, contextWindow = 128000 } = {}) {
  const { server, port } = await startStubServer(stubScript)
  const agentDir = mkdtempSync(path.join(tmpdir(), 'pi-gate-e2e-'))
  // 模型目录指向本机 stub：pi 的 openai provider 不吃 OPENAI_BASE_URL（baseUrl 在
  // 模型目录里逐条定义），所以经 <agentDir>/models.json 注入自定义 provider。
  // contextWindow 可调：compact 的阈值按 reserveTokens（随窗口大小）判定，
  // 小窗口让 stub 短对话也能跨过「session too small」。
  writeFileSync(
    path.join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        stub: {
          name: 'Stub',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: 'stub-key-not-real',
          api: 'openai-completions',
          models: [
            {
              id: 'stub-model',
              name: 'Stub Model',
              api: 'openai-completions',
              baseUrl: `http://127.0.0.1:${port}/v1`,
              contextWindow,
              maxTokens: 4096,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  )
  const args = [
    '--mode', 'rpc',
    '--provider', 'stub',
    '--model', 'stub-model',
    '--no-extensions',
    ...extensions.flatMap((p) => ['-e', p]),
  ]
  if (noSession) args.push('--no-session')
  const proc = spawn('pi', args, {
    cwd: agentDir,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const events = []
  const uiRequests = []
  let stderr = ''
  let buffer = ''
  const waiters = []

  /** 等待满足条件的 stdout 记录出现。 */
  function waitFor(pred, timeoutMs = 30_000, label = '') {
    const existing = events.find(pred)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const w = { pred, resolve, timer: null }
      w.timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(w), 1)
        reject(new Error(`waitFor 超时: ${label}`))
      }, timeoutMs)
      waiters.push(w)
    })
  }

  proc.stdout.on('data', (d) => {
    buffer += d.toString()
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      if (!line.trim()) continue
      let ev
      try {
        ev = JSON.parse(line)
      } catch {
        continue
      }
      events.push(ev)
      if (ev.type === 'extension_ui_request') uiRequests.push(ev)
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(ev)) {
          clearTimeout(waiters[i].timer)
          waiters[i].resolve(ev)
          waiters.splice(i, 1)
        }
      }
    }
  })
  proc.stderr.on('data', (d) => (stderr += d.toString()))
  if (process.env.E2E_DEBUG) {
    proc.stderr.pipe(process.stderr)
    proc.on('exit', (code, sig) => console.log(`  [pi] 退出 code=${code} sig=${sig}`))
  }

  function send(cmd) {
    proc.stdin.write(JSON.stringify(cmd) + '\n')
  }

  /** 审批自动应答：看见 extension_ui_request 就按 confirmed 回答。 */
  function autoApprove(confirmed) {
    proc.stdout.on('data', () => {
      // 应答逻辑在事件解析后统一处理（见上）。这里挂到 uiRequests 轮询。
    })
    const timer = setInterval(() => {
      for (const req of uiRequests) {
        if (req.__answered) continue
        req.__answered = true
        send({ type: 'extension_ui_response', id: req.id, confirmed })
      }
    }, 50)
    return () => clearInterval(timer)
  }

  const cleanup = async () => {
    try { proc.kill('SIGKILL') } catch { /* 已退出 */ }
    server.close()
    try { rmSync(agentDir, { recursive: true, force: true }) } catch { /* 临时目录 */ }
  }

  return { proc, send, events, uiRequests, waitFor, autoApprove, cleanup, stderrText: () => stderr }
}

function rpcResult(events, id) {
  return events.find((e) => e.type === 'response' && e.id === id)
}

// ---------------------------------------------------------------------------
// B1 场景 1：风险命令批准 → 真执行（哨兵文件被删）。
// ---------------------------------------------------------------------------
async function b1Approve() {
  console.log('\n[B1 场景 1] sudo 风险命令批准回路')
  const sentinel = path.join(tmpdir(), 'pi-gate-e2e-sentinel-approve')
  writeFileSync(sentinel, 'x')
  const s = await runScenario('b1-approve', [
    { toolCall: { name: 'bash', args: { command: `rm ${sentinel}` } } },
    { text: 'done' },
  ])
  const stopAuto = s.autoApprove(true)
  try {
    s.send({ id: 'p1', type: 'prompt', message: '删除哨兵文件' })
    // prompt 的 rpc response 是即时 ACK；回合完成要等 agent_settled。
    await s.waitFor((e) => e.type === 'agent_settled', SCENARIO_TIMEOUT_MS, '回合结束（agent_settled）')
    await new Promise((r) => setTimeout(r, 300))
    report('弹出了审批请求（extension_ui_request）', s.uiRequests.length >= 1)
    if (!s.uiRequests.length) dumpEvents(s)
    report('批准后命令真执行（哨兵文件已删）', !existsSync(sentinel))
  } catch (e) {
    report('批准回路完整走通', false, e.message)
    dumpEvents(s)
  } finally {
    stopAuto()
    if (existsSync(sentinel)) rmSync(sentinel, { force: true })
    await s.cleanup()
  }
}

// ---------------------------------------------------------------------------
// B1 场景 2：拒绝 → 不执行（哨兵文件还在）。
// ---------------------------------------------------------------------------
async function b1Deny() {
  console.log('\n[B1 场景 2] 风险命令拒绝回路')
  const sentinel = path.join(tmpdir(), 'pi-gate-e2e-sentinel-deny')
  writeFileSync(sentinel, 'x')
  const s = await runScenario('b1-deny', [
    { toolCall: { name: 'bash', args: { command: `rm ${sentinel}` } } },
    { text: '好的，不删了' },
  ])
  const stopAuto = s.autoApprove(false)
  try {
    s.send({ id: 'p1', type: 'prompt', message: '删除哨兵文件' })
    // 拒绝后 stub 会无限重试被 block 的工具（真实模型会读拒绝原因停下），
    // agent_settled 不可依赖：等审批请求出现 + 固定窗后断言「未执行」。
    await s.waitFor((e) => e.type === 'extension_ui_request', SCENARIO_TIMEOUT_MS, '审批请求')
    await new Promise((r) => setTimeout(r, 3000))
    report('弹出了审批请求', s.uiRequests.length >= 1)
    report('拒绝后未执行（哨兵文件还在）', existsSync(sentinel))
  } catch (e) {
    report('拒绝回路完整走通', false, e.message)
    dumpEvents(s)
  } finally {
    stopAuto()
    rmSync(sentinel, { force: true })
    await s.cleanup()
  }
}

// ---------------------------------------------------------------------------
// B1 场景 3：灾难命令硬闸 → 无横幅直接 block，文件未被删。
// ---------------------------------------------------------------------------
async function b1Disaster() {
  console.log('\n[B1 场景 3] 灾难命令（rm -rf）硬闸')
  const dir = path.join(tmpdir(), 'pi-gate-e2e-victim')
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'keep.txt'), 'x')
  const s = await runScenario('b1-disaster', [
    { toolCall: { name: 'bash', args: { command: `rm -rf ${dir}` } } },
    { text: '收到' },
  ])
  const stopAuto = s.autoApprove(true) // 就算有人乱批准，灾难也必须拦
  try {
    s.send({ id: 'p1', type: 'prompt', message: '删除目录' })
    // block+terminate 应结束回合；给 agent_settled 与固定窗双保险。
    await Promise.race([
      s.waitFor((e) => e.type === 'agent_settled', SCENARIO_TIMEOUT_MS, '回合结束'),
      new Promise((r) => setTimeout(r, 8000)),
    ])
    await new Promise((r) => setTimeout(r, 300))
    report('灾难命令未弹审批（直接 block）', s.uiRequests.length === 0)
    report('灾难命令未执行（目录还在）', existsSync(path.join(dir, 'keep.txt')))
  } catch (e) {
    report('灾难硬闸生效', false, e.message)
  } finally {
    stopAuto()
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理 */ }
    await s.cleanup()
  }
}

// ---------------------------------------------------------------------------
// B3 场景：rpc compact 回路。
// ---------------------------------------------------------------------------
async function b3Compact() {
  console.log('\n[B3 场景] rpc compact 压缩回路')
  const filler = '历史正文填充。'.repeat(60000) // shouldCompact: tokens > contextWindow(128k) - reserveTokens(16384 常量) ≈ 111k
  const s = await runScenario(
    'b3-compact',
    [
      { text: `第一轮回答 ${filler}` },
      { text: `第二轮回答 ${filler}` },
      { text: `第三轮回答 ${filler}` },
      { text: 'STUB-SUMMARY：这是压缩摘要' },
    ],
    { extensions: [], noSession: false }, // compact 需要会话上下文
  )
  try {
    for (const [i, id] of ['p1', 'p2', 'p3'].entries()) {
      s.send({ id, type: 'prompt', message: `第 ${i + 1} 轮对话` })
      await s.waitFor((e) => e.type === 'agent_settled', SCENARIO_TIMEOUT_MS, `第 ${i + 1} 轮结束`)
    }
    s.send({ id: 'c1', type: 'compact' })
    const res = await s.waitFor((e) => e.type === 'response' && e.id === 'c1', SCENARIO_TIMEOUT_MS, 'compact 响应')
    report('compact 响应成功', res.success === true, JSON.stringify(res).slice(0, 200))
  } catch (e) {
    report('compact 回路走通', false, e.message)
  } finally {
    await s.cleanup()
  }
}

// ---------------------------------------------------------------------------
console.log('B1/B3 无头端到端回归（stub 模型 + 真 pi 内核 + 真 gate 扩展）')
const only = process.env.E2E_ONLY
const want = (n) => !only || only === n
if (want('b1a')) await b1Approve()
if (want('b1d')) await b1Deny()
if (want('b1x')) await b1Disaster()
if (want('b3')) await b3Compact()
console.log(`\n结果：${passed} 过 / ${failed} 挂`)
process.exit(failed ? 1 : 0)
