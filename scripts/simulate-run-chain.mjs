#!/usr/bin/env node
/**
 * 专家协作模拟器：把 WorkBuddy 的「主理人 → 专家 → 交接 → 合并」流程按真实事件形状
 * 逐步推给界面，专供运行链路实时视图做人工验收。
 *
 * 为什么走浏览器桩而不是写 journal：
 *   · 实时视图消费 `pi://event`；journal 只在开页时回放，走 journal 看不到「逐段点亮」。
 *   · 桩页面里没有任何后端写入，跑多少遍都不会污染真实会话与 `.pi/journal/events.jsonl`。
 *
 * 事件信封（runId / agentId / spanId / parentSpanId / spanKind / 起止时间）与桥侧
 * `pi_run.rs` 同形，所以界面走的是正式链路，不是降级路径。
 *
 * 用法：
 *   pnpm build && node scripts/simulate-run-chain.mjs
 *   node scripts/simulate-run-chain.mjs --speed=3          # 3 倍速
 *   node scripts/simulate-run-chain.mjs --scenario=blocked # 只跑一个
 *   node scripts/simulate-run-chain.mjs --scenario=normal,retry
 *   node scripts/simulate-run-chain.mjs --clean            # 清掉上次截图
 *
 * 依赖：playwright-core + 本机 Chrome（与 visual-check.mjs 相同）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findChrome, inspectRunGraph, loadPlaywright, serveDist } from './lib/preview.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')
const OUT = path.join(ROOT, '.visual-check', 'run-chain')
const PORT = Number(process.env.SIM_PORT ?? 4322)

/** WorkBuddy code-crew 的真实角色与工具集（本机 plugin.json 核实）。 */
const ROLES = {
  lead: { id: 'code-crew-team-lead', name: 'Horizon', profession: '代码小队队长', tools: ['read', 'bash', 'codebase_search'] },
  vera: { id: 'code-investigator', name: 'Vera', profession: '调查员', tools: ['read', 'bash', 'codebase_search', 'codebase_query'] },
  max: { id: 'code-implementer', name: 'Max', profession: '实现工程师', tools: ['read', 'edit', 'bash'] },
  ray: { id: 'code-reviewer', name: 'Ray', profession: '审查员', tools: ['read', 'bash'] },
}

/**
 * 浏览器桩：只回前端真的会调的读接口；写接口一律不落盘。
 * `agent_team_runs` 返回可变数组，脚本跑场景时往里追加，团队分道才能显示本次模拟。
 */
const STUB = `
(() => {
  const D = (window.__PI_SIM_DATA__ ||= {})
  D.teamRuns ||= []
  D.projects ||= [
    { id: 'p-sim', name: '专家协作模拟', path: '/tmp/sim-repo', archived: false, updated_at: Date.now() },
  ]
  D.active ||= 'p-sim'
  let cbId = 0
  window.__PI_STUB__ = { calls: [], listeners: {}, sent: [] }
  // 事件插件退订时会回调这个内部对象，不打桩会在离开对话页时抛错。
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {}, registerListener() {} }
  function emitPi(rec) {
    const ids = window.__PI_STUB__.listeners['pi://event'] || []
    for (const id of ids) {
      const fn = window['_' + id]
      if (fn) fn({ event: 'pi://event', payload: rec, id: 0 })
    }
  }
  window.__PI_STUB__.emitPi = emitPi
  window.__TAURI_INTERNALS__ = {
    transformCallback(cb, once) {
      const id = ++cbId
      Object.defineProperty(window, '_' + id, {
        value: (...a) => { if (once) delete window['_' + id]; cb(...a) },
        writable: true,
        configurable: true,
      })
      return id
    },
    convertFileSrc: (s) => s,
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    invoke(cmd, args) {
      const r = (v) => Promise.resolve(v)
      window.__PI_STUB__.calls.push(cmd)
      if (cmd === 'projects_list') return r(D.projects)
      if (cmd === 'project_active') return r(D.active)
      if (cmd === 'project_set_active') { D.active = args.id; return r(null) }
      if (cmd === 'project_set_path') return r(null)
      if (cmd === 'project_get') {
        return r({
          project: D.projects[0],
          config: {
            id: 'cfg-sim',
            project_id: D.active,
            number: 3,
            instruction: '',
            capabilities: [],
            created_by: 'me',
            created_at: Date.now(),
          },
          work_items: [],
          assets: [],
          tasks: [],
          activity: [],
          instruction_usage: { tokens: 0, budget: 4000 },
        })
      }
      if (cmd === 'role_list') return r([])
      if (cmd === 'role_current') return r({ id: 'general', name: '通用', description: '', prompt: '' })
      if (cmd === 'settings_load') return r({ models: [] })
      if (cmd === 'pi_doctor') return r({ found: true, path: '/opt/homebrew/bin/pi', probed: 3, error: null })
      // 关键：不读也不写真实 journal，历史回放恒为空。
      if (cmd === 'pi_journal_read') return r([])
      if (cmd === 'pi_send') {
        try { window.__PI_STUB__.sent.push(JSON.parse(args.json).message) } catch {}
        return r(null)
      }
      if (cmd === 'agent_teams_list') return r(D.teams || [])
      if (cmd === 'agent_team_runs') return r(D.teamRuns)
      if (cmd === 'extensions_list') return r(D.extensions || [])
      if (cmd === 'proactive_snapshot') return r({ jobs: [], inbox: [], unread: 0, runningJob: null, grantUsage: null })
      if (cmd === 'conversations_list' || cmd === 'conversation_list') return r([])
      if (cmd === 'fs_read_dir') return r([])
      if (cmd === 'fs_read_file') return r('')
      if (cmd === 'library_search') return r([])
      if (cmd === 'library_marks') return r([])
      if (cmd === 'library_tree') return r([])
      if (cmd === 'checkpoint_begin_turn') {
        window.__PI_STUB__.turnSeq = (window.__PI_STUB__.turnSeq ?? 0) + 1
        return r(window.__PI_STUB__.turnSeq)
      }
      if (cmd === 'plugin:event|listen' && args && args.handler) {
        const list = (window.__PI_STUB__.listeners[args.event] ??= [])
        if (!list.includes(args.handler)) list.push(args.handler)
        return r(args.handler)
      }
      if (typeof cmd === 'string' && cmd.includes('|listen')) return r(0)
      return r(null)
    },
  }
})()
`

const FLAGS = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
    return m ? [m[1], m[2] ?? 'true'] : ['', a]
  }),
)
const SPEED = Math.min(20, Math.max(0.1, Number(FLAGS.speed ?? 1) || 1))
const WANT = String(FLAGS.scenario ?? 'all')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 倍速只压缩模拟等待，不改事件里的真实时间戳。 */
const hold = (ms) => sleep(ms / SPEED)

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`)
}

/** 一个场景 = 一条请求 = 一个 runId。 */
function makeRun(name) {
  const now = Date.now()
  return { runId: `run-sim-${name}-${now.toString(16)}`, startedAt: now, seq: 0 }
}

async function main() {
  if (FLAGS.clean) {
    fs.rmSync(OUT, { recursive: true, force: true })
    console.log(`已清理 ${path.relative(ROOT, OUT)}`)
    return
  }
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error('dist/index.html 不存在，请先执行 pnpm build。')
    process.exit(2)
  }
  const chrome = findChrome()
  if (!chrome) {
    console.error('未找到 Chrome/Chromium。请安装，或设置 CHROME_PATH=<可执行文件路径> 后重试。')
    process.exit(2)
  }

  const { chromium } = loadPlaywright()
  fs.mkdirSync(OUT, { recursive: true })
  const { server, url } = await serveDist(DIST, PORT)
  const browser = await chromium.launch({ executablePath: chrome })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))

  const scenarios = Object.keys(SCENARIOS)
  const picked = WANT === 'all' ? scenarios : WANT.split(',').map((s) => s.trim()).filter(Boolean)
  for (const s of picked) {
    if (!SCENARIOS[s]) {
      console.error(`未知场景 ${s}。可选：${scenarios.join(' / ')} / all`)
      process.exit(2)
    }
  }

  // mock 数据：团队、核心扩展、本次模拟的成员调度记录占位。
  await page.addInitScript(
    `window.__PI_SIM_DATA__ = ${JSON.stringify({
      teams: [
        {
          id: 'sim-code-crew',
          name: '代码小队 CodeCrew',
          members: ['Horizon', 'Vera', 'Max', 'Ray'],
          strategy: 'sequential',
          created_at: Date.now(),
          runs: picked.length,
        },
      ],
      extensions: [
        { id: 'agent-tool-gate.ts', name: '工具门', kind: 'tool', path: '/ext/agent-tool-gate.ts', tools: ['gate_status'], enabled: true },
        { id: 'agent-teams.ts', name: '专家团队', kind: 'tool', path: '/ext/agent-teams.ts', tools: ['team_run'], enabled: true },
      ],
    })}`,
  )
  await page.addInitScript(STUB)
  await page.goto(`${url}/#/chat`, { waitUntil: 'load' })
  await page.waitForTimeout(700)

  const emit = (rec) => page.evaluate((r) => window.__PI_STUB__.emitPi(r), rec)
  const pushTeamRuns = (rows) =>
    page.evaluate((rs) => window.__PI_SIM_DATA__.teamRuns.push(...rs), rows)

  // 内核拉起只发生一次；后续请求复用同一个内核。
  const kernel = { type: 'kernel_start', agentId: 'main', pid: 5150, extensions: ['agent-tool-gate', 'agent-teams'], cwd: '/tmp/sim-repo', pi_ts: Date.now() }
  await emit(kernel)

  let first = true
  let drawerOpen = false
  const runIds = {}
  for (const name of picked) {
    const run = makeRun(name)
    runIds[name] = run.runId
    const prompt = PROMPTS[name]
    console.log(`\n── 场景 ${name}：${prompt}`)
    await sendPrompt(page, prompt, first)
    first = false
    const api = helpers(run, emit, page)
    await api.open(prompt)
    await page.waitForTimeout(200)
    if (!drawerOpen) {
      // 运行链路入口已收进顶栏 .trace-toggle（气泡下不再重复渲染入口）。
      await page.locator('.trace-toggle').first().click()
      await page.waitForTimeout(600)
      check('[入口] 点顶栏入口展开轨迹抽屉', (await page.locator('.trace-drawer.open').count()) === 1)
      const onTab = (await page.locator('.td-tab.on').first().innerText().catch(() => '')).trim()
      check('[入口] 抽屉停在轨迹页签', onTab.includes('轨迹'), `tab=${onTab}`)
      drawerOpen = true
    }
    await SCENARIOS[name](api)
    await pushTeamRuns(teamRows(name, run, api))
    await page.waitForTimeout(400)
    // 每轮截图前把本轮节点图滚进视野（抽屉自己是一个滚动容器）。
    await page.locator(`.trace-drawer [data-run-id="${run.runId}"]`).scrollIntoViewIfNeeded().catch(() => {})
    await page.waitForTimeout(150)
    const shot = path.join(OUT, `${name}.png`)
    await page.screenshot({ path: shot, fullPage: true })
    console.log(`   截图 ${path.relative(ROOT, shot)}`)
    await verifyScenario(page, name, run.runId)
  }

  // 主干折叠：只藏在成功的工具节点，异常环节一个都不藏。
  if (runIds.normal) {
    // 旧轮次默认折叠成 .run-fold 摘要，先点开才铺图（与 visual-check 同一口径）。
    const foldBtn = page.locator(`.trace-drawer .run-fold[data-run-id="${runIds.normal}"]`)
    if (await foldBtn.count()) {
      await foldBtn.click()
      await page.waitForTimeout(200)
    }
    const foldTarget = page.locator(`.trace-drawer [data-run-id="${runIds.normal}"]`)
    const before = await foldTarget.locator('.rg-node').count()
    await foldTarget.locator('.rg-trunk').click()
    await page.waitForTimeout(150)
    const after = await foldTarget.locator('.rg-node').count()
    check('主干折叠：收起成功的工具节点', after < before, `${before}→${after}`)
    await foldTarget.locator('.rg-trunk').click()
  } else {
    console.log('INFO  主干折叠仅在 normal 场景校验（异常场景不藏节点）')
  }

  // 窄屏（390）：抽屉 overlay 只剩一列，逐轮体检节点不重叠 / 连线不穿节点 / 文字不裁。
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(500)
  for (const name of picked) {
    const graph = page.locator(`.trace-drawer [data-run-id="${runIds[name]}"]`)
    await graph.scrollIntoViewIfNeeded().catch(() => {})
    await page.waitForTimeout(150)
    const geo = await inspectRunGraph(graph)
    check(`[390][${name}] 节点不重叠`, geo.overlaps === 0, `overlaps=${geo.overlaps}`)
    check(`[390][${name}] 连线不穿节点`, geo.crossings === 0, `crossings=${geo.crossings}`)
    check(`[390][${name}] 文字不被裁`, geo.clipped === 0, `clipped=${geo.clipped}`)
    check(`[390][${name}] 无横向溢出`, geo.overflow <= 1, `overflow=${geo.overflow}`)
    const shot = path.join(OUT, `390-${name}.png`)
    await page.locator('.trace-drawer').screenshot({ path: shot }).catch(() => {})
  }
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(400)

  // 团队分道：打开过程面板的「智能体」页签。
  await page.locator('.td-tab', { hasText: '智能体' }).first().click()
  await page.waitForTimeout(400)
  // 组件在 onMounted 读一次 teamRuns，而场景数据是逐轮 push 的——
  // 切页签时挂载早于最后一次 push，需点刷新按钮重读，否则分道为空。
  await page.locator('.al-refresh').first().click().catch(() => {})
  await page.waitForTimeout(600)
  const lanes = await page.locator('.agent-lanes .al-lane').count()
  const handoffs = await page.locator('.agent-lanes .al-handoff').count()
  await page.screenshot({ path: path.join(OUT, 'lanes.png'), fullPage: true })
  // 只跑单个场景时成员调度记录本来就少，分道断言只在多场景下有参考价值。
  if (picked.length > 1) {
    check('团队分道：至少 3 个成员泳道', lanes >= 3, `lanes=${lanes}`)
    check('团队分道：顺序策略标出交接点', handoffs >= 1, `handoffs=${handoffs}`)
  } else {
    console.log(`INFO  团队分道 lanes=${lanes} handoffs=${handoffs}（单场景不设阈值）`)
  }

  console.log('\n── 对照清单 ─────────────────────────────────────────')
  for (const s of picked) console.log(`  ${CHECKLIST[s]}`)
  console.log(`\n截图目录：${path.relative(ROOT, OUT)}（--clean 可清理）`)

  await browser.close()
  server.close()
  if (pageErrors.length) {
    console.error(`\n页面异常 ${pageErrors.length} 条：`)
    for (const e of pageErrors) console.error(`  ${e}`)
  }
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} 项断言通过`)
  process.exit(failed || pageErrors.length ? 1 : 0)
}

/** 点掉审批横幅（批准 / 拒绝），让它与链路里的工具门结论一致。 */
async function respondBanner(page, confirmed) {
  const btn = page.locator(`.approval .approval-btn.${confirmed ? 'approve' : 'reject'}`).first()
  if (await btn.count()) {
    await btn.click().catch(() => {})
    await page.waitForTimeout(120)
  }
}

/** 首条走落地页输入框，之后走会话输入框。 */
async function sendPrompt(page, text, first) {
  if (first) {
    await page.locator('.hero-input-wrap .app-textarea').first().click()
    await page.keyboard.type(text)
    await page.locator('.hero-send').click()
  } else {
    await page.locator('.composer .app-textarea').first().click()
    await page.keyboard.type(text)
    await page.locator('.composer .send').click()
  }
  await page.waitForTimeout(250)
}

/** 校验轨迹抽屉里本轮的节点图：节点数、状态类、降级标记与几何可读性。 */
async function verifyScenario(page, name, runId) {
  const graph = page.locator(`.trace-drawer [data-run-id="${runId}"]`)
  check(`[${name}] 气泡下不重复渲染运行链路入口`, (await page.locator('.msgs .run-entry').count()) === 0)
  check(`[${name}] 抽屉里出现本轮节点图`, (await graph.count()) === 1)
  const nodes = await graph.locator('.rg-node').count()
  check(`[${name}] 链路按节点纵向渲染`, nodes >= 4, `nodes=${nodes}`)
  const expect = EXPECTED[name] ?? {}
  for (const [cls, min] of Object.entries(expect)) {
    const n = await graph.locator(`.rg-node.is-${cls}`).count()
    check(`[${name}] 出现 ${cls} 环节`, n >= min, `count=${n}`)
  }
  check(`[${name}] 链路未落入降级聚合`, !(await graph.locator('.rg-note').count()), runId)
  if (name === 'interrupt') {
    // 整轮中断后，未收口的环节必须跟着落成中断态，不能停在「进行中」。
    const running = await graph.locator('.rg-node.is-run').count()
    check('[interrupt] 没有环节停在进行中', running === 0, `running=${running}`)
  }
  if (name === 'expert') {
    const titles = (await graph.locator('.rg-node-title').allTextContents()).map((t) => t || '')
    check('[expert] 链路里出现「专家 代码评审专家 接管」', titles.some((t) => t.includes('专家 代码评审专家 接管')), titles.join(' | ').slice(0, 160))
    check('[expert] 链路里出现「交接给专家 实现专家」', titles.some((t) => t.includes('交接给专家 实现专家')), titles.join(' | ').slice(0, 160))
  }
  const geo = await inspectRunGraph(graph)
  check(`[${name}] 节点不重叠`, geo.overlaps === 0, `overlaps=${geo.overlaps}`)
  check(`[${name}] 连线不穿节点`, geo.crossings === 0, `crossings=${geo.crossings}`)
  check(`[${name}] 文字不被裁`, geo.clipped === 0, `clipped=${geo.clipped}`)
  check(`[${name}] 无横向溢出`, geo.overflow <= 1, `overflow=${geo.overflow}`)
}

/** 场景里每一段都会用到的事件发射器（信封含义与 pi_run.rs 一致）。 */
function helpers(run, emit, page) {
  const base = () => ({ runId: run.runId, runStartedAt: run.startedAt })
  const span = () => `sp-${++run.seq}`
  const turn = span()

  const api = {
    run,
    emit,
    page,
    at: () => Date.now(),
    async open(prompt) {
      await emit({
        type: 'run_start',
        ...base(),
        agentId: ROLES.lead.id,
        prompt: prompt.slice(0, 160),
        pi_ts: Date.now(),
      })
      await emit({
        type: 'turn_start',
        ...base(),
        agentId: ROLES.lead.id,
        spanId: turn,
        spanKind: 'turn',
        spanStartedAt: Date.now(),
        pi_ts: Date.now(),
      })
    },
    /** 一段模型调用（每个角色一次），带真实起止。 */
    async model(agent, text, ms) {
      const id = span()
      const t0 = Date.now()
      const env = { ...base(), agentId: agent.id, spanId: id, parentSpanId: turn, spanKind: 'model' }
      await emit({ type: 'message_start', message: { role: 'assistant', content: [] }, ...env, spanStartedAt: t0, pi_ts: t0 })
      await emit({
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: { type: 'text_delta', delta: text },
        ...env,
        spanStartedAt: t0,
        pi_ts: Date.now(),
      })
      await hold(ms)
      await emit({
        type: 'message_end',
        message: { role: 'assistant', content: [], usage: { input: 180, output: 60, totalTokens: 240 } },
        ...env,
        spanStartedAt: t0,
        spanEndedAt: Date.now(),
        pi_ts: Date.now(),
      })
      return id
    },
    /** 一次工具调用；parent 用最近一段模型，符合桥侧 current_parent 规则。 */
    async tool(agent, parent, name_, args, output, ms, isError = false) {
      const id = span()
      const t0 = Date.now()
      const callId = `call-${id}`
      const env = { ...base(), agentId: agent.id, spanId: id, parentSpanId: parent, spanKind: 'tool' }
      await emit({ type: 'tool_execution_start', toolCallId: callId, toolName: name_, args, ...env, spanStartedAt: t0, pi_ts: t0 })
      await hold(ms)
      await emit({
        type: 'tool_execution_end',
        toolCallId: callId,
        toolName: name_,
        args,
        isError,
        result: { content: [{ type: 'text', text: output }] },
        ...env,
        spanStartedAt: t0,
        spanEndedAt: Date.now(),
        pi_ts: Date.now(),
      })
      return id
    },
    /** 先开一个工具调用并返回收尾函数——用来模拟「跑了很久还没结束」的环节。 */
    async toolOpen(agent, parent, name_, args) {
      const id = span()
      const t0 = Date.now()
      const callId = `call-${id}`
      const env = { ...base(), agentId: agent.id, spanId: id, parentSpanId: parent, spanKind: 'tool' }
      await emit({ type: 'tool_execution_start', toolCallId: callId, toolName: name_, args, ...env, spanStartedAt: t0, pi_ts: t0 })
      return async (output, isError = false) => {
        await emit({
          type: 'tool_execution_end',
          toolCallId: callId,
          toolName: name_,
          args,
          isError,
          result: { content: [{ type: 'text', text: output }] },
          ...env,
          spanStartedAt: t0,
          spanEndedAt: Date.now(),
          pi_ts: Date.now(),
        })
      }
    },
    /** 工具门：confirm 请求 + 结论，配对同一个 gate span。 */
    async gate(agent, parent, title, ms, confirmed) {
      const id = span()
      const gateId = `gate-${id}`
      const t0 = Date.now()
      const env = { ...base(), agentId: agent.id, spanId: id, parentSpanId: parent, spanKind: 'gate' }
      await emit({
        type: 'extension_ui_request',
        method: 'confirm',
        id: gateId,
        title,
        ...env,
        spanStartedAt: t0,
        pi_ts: t0,
      })
      await hold(ms)
      await emit({
        type: 'gate_decision',
        gateId,
        confirmed,
        ...env,
        spanStartedAt: t0,
        spanEndedAt: Date.now(),
        pi_ts: Date.now(),
      })
      // 产品里的审批横幅只认用户点击：模拟点击同一结论，避免横幅一路挂到结束。
      await respondBanner(page, confirmed)
    },
    /** 只开不结的审批：spanStartedAt 回拨 91s，模拟 90s 未决（等价于真等 91 秒）。 */
    async gateExpired(agent, parent, title) {
      const id = span()
      const t0 = Date.now() - 91_000
      await emit({
        type: 'extension_ui_request',
        method: 'confirm',
        id: `gate-${id}`,
        title,
        ...base(),
        agentId: agent.id,
        spanId: id,
        parentSpanId: parent,
        spanKind: 'gate',
        spanStartedAt: t0,
        pi_ts: t0,
      })
    },
    async retry(attempt, message, ms) {
      const id = span()
      const t0 = Date.now()
      await emit({
        type: 'auto_retry_start',
        attempt,
        errorMessage: message,
        ...base(),
        agentId: ROLES.lead.id,
        spanId: id,
        parentSpanId: turn,
        spanKind: 'retry',
        spanStartedAt: t0,
        pi_ts: t0,
      })
      await hold(ms)
      await emit({
        type: 'auto_retry_end',
        attempt,
        success: true,
        ...base(),
        agentId: ROLES.lead.id,
        spanId: id,
        parentSpanId: turn,
        spanKind: 'retry',
        spanStartedAt: t0,
        spanEndedAt: Date.now(),
        pi_ts: Date.now(),
      })
    },
    async settle(status = 'ok') {
      await emit({
        type: 'agent_settled',
        ...base(),
        agentId: ROLES.lead.id,
        spanId: turn,
        spanKind: 'turn',
        spanStartedAt: run.startedAt,
        spanEndedAt: Date.now(),
        runEndedAt: Date.now(),
        runStatus: status,
        pi_ts: Date.now(),
      })
    },
    /** 内核中途退出：整轮收口为 interrupted（界面显示「已中断」，不是「失败」）。 */
    async interrupt() {
      await emit({
        type: 'process_exit',
        ...base(),
        agentId: ROLES.lead.id,
        runEndedAt: Date.now(),
        runStatus: 'interrupted',
        pi_ts: Date.now(),
      })
    },
    /** 团队调度日志：成员产出，供分道视图读取。 */
    member(name, ok, output, round = 1) {
      // IPC 契约：后端把磁盘日志的 runId 映射为 run_id，前端也按 run_id 聚合。
      return { run_id: run.runId, member: name, ok, output, at: Date.now(), round, strategy: 'sequential', real: true }
    },
  }
  return api
}

function teamRows(name, run, api) {
  const rows = [{ run_id: run.runId, strategy: 'sequential', real: true, at: run.startedAt }]
  const outputs = {
    normal: [
      ['Vera', true, 'STATUS: PASS｜索引写入死锁根因：持锁调用 save 重入。证据 src/index/store.ts:112。'],
      ['Max', true, 'STATUS: PASS｜改为锁外提交，新增 2 处回归断言。'],
      ['Ray', true, 'STATUS: PASS｜改动面 2 文件，无越界修改，可合并。'],
    ],
    long: [['Vera', true, 'STATUS: PASS｜全量测试进行中，已读 214 个用例。']],
    blocked: [['Vera', true, 'STATUS: BLOCKED｜清理命令被工具门拒绝，改用只读排查继续。']],
    retry: [
      ['Max', false, 'STATUS: FAIL｜类型检查未通过：AgentLanes 里 payload 可能为 null。'],
      ['Max', true, 'STATUS: PASS｜补空值判空后重跑通过。'],
    ],
    interrupt: [['Vera', false, 'STATUS: BLOCKED｜执行中被中断，未产出报告。']],
    timeout: [['Vera', false, 'STATUS: BLOCKED｜等待审批超时，未执行命令。']],
  }[name] ?? []
  let round = 0
  let last = ''
  for (const [member, ok, output] of outputs) {
    round = member === last ? round + 1 : 1
    last = member
    rows.push({ ...api.member(member, ok, output, round) })
  }
  return rows
}

const PROMPTS = {
  normal: '排查索引写入死锁并给出修复方案',
  long: '跑一遍全量测试确认没有回归',
  blocked: '清理构建产物后重新打包',
  retry: '修一下分道视图的空值崩溃',
  interrupt: '分析一下上次失败的日志',
  timeout: '给内核进程做一次权限审批',
  expert: '让评审专家看完改动后交接给实现专家修复',
}

/** 每个场景期望出现的节点状态类（用于自动对照）。 */
const EXPECTED = {
  normal: {},
  long: {},
  blocked: { blocked: 1 },
  retry: { failed: 1 },
  interrupt: { cancelled: 1 },
  timeout: { timeout: 1 },
  expert: { failed: 1 },
}

/** 人工核对清单：跑完界面应该看到什么。 */
const CHECKLIST = {
  normal: 'normal    正常完成：节点图从请求进入 → 内核 → 模型（Horizon/Vera/Max/Ray，按成员分道）→ 工具（含 1 次工具门确认）→ 轮次结束；末节点绿色，摘要「模型 → N 次工具 → 完成」。',
  long: 'long      长任务：pnpm test 节点保持进行中，超 10s 后描边变虚线、耗时前加「已耗时」，数字每秒增长；收口后变绿。',
  blocked: 'blocked   门拒绝：工具门节点标黄并写「被工具门拒绝」，对应工具节点失败；整轮仍是「完成」，摘要出现「1 次被拒」。',
  retry: 'retry     失败重试：Max 的工具节点标红（错误原文点开可见），随后出现「自动重试」节点并成功；整轮完成。',
  interrupt: 'interrupt 中途中断：整轮「已中断」，未收口的工具节点跟着变灰（已中断），不再停在「进行中」。',
  timeout: 'timeout   审批超时：工具门节点标黄「等待审批超时」，与「被拒」「失败」区分开（时间回拨等价模拟 90s 未决）。',
  expert: 'expert    专家接力：链路里先出现「专家 代码评审专家 接管」，越界的 bash 标红并写明未授权，随后出现「交接给专家 实现专家」，实现专家继续做修复。',
}

const SCENARIOS = {
  /** 正常完成：主理人拆任务 → 两个专家 + 审查 → 合并交付。 */
  async normal(a) {
    const lead = await a.model(ROLES.lead, '收到。拆成三步：Vera 查根因、Max 改实现、Ray 审改动。先派 Vera。', 700)
    await a.tool(ROLES.lead, lead, 'codebase_search', { query: '索引写入 死锁' }, '命中 6 处：src/index/store.ts:112 持锁调用 save。', 380)
    const vera = await a.model(ROLES.vera, '先只读排查，不改文件。', 500)
    await a.tool(ROLES.vera, vera, 'read', { path: 'src/index/store.ts' }, '1  fn save(db) {\n2    db.lock(() => this.write())   // 锁内重入', 420)
    await a.gate(ROLES.vera, vera, '允许运行 bash：rg "save\\(" src', 900, true)
    await a.tool(ROLES.vera, vera, 'bash', { command: 'rg "save\\(" src' }, 'src/index/store.ts:112\nsrc/index/queue.ts:44', 520)
    await a.model(ROLES.vera, 'STATUS: PASS｜根因是持锁重入，建议改为锁外提交。', 600)
    const max = await a.model(ROLES.max, '接到 Vera 的报告，开始改实现。', 400)
    await a.tool(ROLES.max, max, 'edit', { path: 'src/index/store.ts' }, 'updated 1 file: 把 save 移出锁区', 500)
    await a.tool(ROLES.max, max, 'bash', { command: 'pnpm test -- --runInBand' }, 'Tests: 229 passed', 800)
    await a.model(ROLES.max, 'STATUS: PASS｜改动完成，测试全绿。', 500)
    await a.model(ROLES.ray, 'STATUS: PASS｜变更面 2 文件，无越界，可合并。交付物：.agent-runs/2026-11-12/deadlock/summary.md', 600)
    await a.settle()
  },

  /** 长任务：真实等 11s（倍速不压缩），验证进行中计时。 */
  async long(a) {
    const lead = await a.model(ROLES.lead, '先跑一遍全量测试，等结果再判断。', 500)
    const done = await a.toolOpen(ROLES.lead, lead, 'bash', { command: 'pnpm test' })
    // 超过 10s 的环节：这里等真实 11s，倍速不参与，否则验不到「已耗时」。
    await sleep(11_000)
    const pending = await a.page
      .locator(`.trace-drawer [data-run-id="${a.run.runId}"]`)
      .locator('.rg-node.is-run')
      .count()
    check('[long] 进行中的节点保持持续状态', pending >= 1, `running=${pending}`)
    const marked = await a.page
      .locator(`.trace-drawer [data-run-id="${a.run.runId}"]`)
      .locator('.rg-node.is-long')
      .count()
    check('[long] 超 10s 环节显示「已耗时」并持续刷新', marked >= 1, `count=${marked}`)
    await done('Tests: 229 passed', false)
    await a.model(ROLES.lead, '全量测试通过，无回归。', 500)
    await a.settle()
  },

  /** 工具门拒绝：危险命令被拦，链路里独立成「被拒」。 */
  async blocked(a) {
    const lead = await a.model(ROLES.lead, '先清理构建产物，再重新打包。', 500)
    const vera = await a.model(ROLES.vera, '执行清理命令。', 400)
    await a.gate(ROLES.vera, vera, '允许运行 bash：rm -rf build', 900, false)
    await a.tool(ROLES.vera, vera, 'bash', { command: 'rm -rf build' }, 'Denied by tool gate: 命令命中禁止模式 rm -rf', 260, true)
    await a.model(ROLES.vera, 'STATUS: BLOCKED｜清理命令被拒，改用只读方式确认产物列表。', 500)
    await a.settle()
  },

  /** 成员失败 → 主理人重试 → 成功。 */
  async retry(a) {
    const lead = await a.model(ROLES.lead, '让 Max 修空值崩溃，失败就重试一次。', 500)
    const max = await a.model(ROLES.max, '开始改 AgentLanes 的 payload 判空。', 500)
    await a.tool(ROLES.max, max, 'bash', { command: 'pnpm typecheck' }, "src/components/chat/AgentLanes.vue(57,18): error TS18047: 'payload' is possibly 'null'.", 700, true)
    await a.model(ROLES.max, 'STATUS: FAIL｜类型检查未通过。', 400)
    await a.retry(1, '成员执行失败：类型检查未通过 TS18047', 1200)
    await a.tool(ROLES.max, max, 'bash', { command: 'pnpm typecheck' }, 'vue-tsc --noEmit: 0 errors', 700)
    await a.model(ROLES.max, 'STATUS: PASS｜补判空后重跑通过。', 500)
    await a.settle()
  },

  /** 中途中断：内核退出时工具还没收口，整轮与环节都要落成「已中断」。 */
  async interrupt(a) {
    const lead = await a.model(ROLES.lead, '先读上次失败日志，准备定位。', 500)
    const vera = await a.model(ROLES.vera, '开始读取日志…', 400)
    // 故意只开不收：验证未收口环节会跟着整轮变中断，而不是永远「进行中」。
    await a.toolOpen(ROLES.vera, vera, 'bash', { command: 'rg ERROR .pi/logs/failure.log' })
    await hold(600)
    await a.interrupt()
  },

  /** 审批超时：90s 无人应答（时间回拨等价模拟）。 */
  async timeout(a) {
    const lead = await a.model(ROLES.lead, '这条命令需要你确认，我先等你。', 500)
    await a.gateExpired(ROLES.lead, lead, '允许运行 bash：sudo launchctl reload pi')
    await a.model(ROLES.lead, '等待审批超时，本轮不再执行该命令。', 500)
    await a.settle()
  },

  /** 专家接力：评审专家接管 → 越界工具被拦 → 交接给实现专家、上一位产出作为下一位输入。 */
  async expert(a) {
    await a.emit({
      type: 'expert_start',
      runId: a.run.runId,
      runStartedAt: a.run.startedAt,
      expertId: 'code-reviewer',
      expertName: '代码评审专家',
      allowedTools: ['read', 'grep'],
      pi_ts: Date.now(),
    })
    const review = await a.model(ROLES.ray, '先只读评审，标出这次改动的风险。', 400)
    await a.tool(ROLES.ray, review, 'read', { path: 'src/index/store.ts' }, '1  fn save(db) { 把 save 移出锁区 }', 320)
    // 越界：该专家只有 read/grep，bash 被工具门直接拦下（与真实 gate 返回同一句 reason）。
    await a.tool(
      ROLES.ray,
      review,
      'bash',
      { command: 'rm -rf build' },
      '专家「代码评审专家」未授权工具 bash（允许：read、grep）',
      220,
      true,
    )
    await a.model(ROLES.ray, 'STATUS: PASS｜风险清单已给出，交接给实现专家修复。', 400)

    // 第二棒：上一位产出作为输入，链路里出现「交接给专家」。
    await a.emit({
      type: 'expert_start',
      runId: a.run.runId,
      runStartedAt: a.run.startedAt,
      expertId: 'code-implementer',
      expertName: '实现专家',
      handoffFrom: '代码评审专家',
      allowedTools: ['read', 'edit', 'bash'],
      pi_ts: Date.now(),
    })
    const fix = await a.model(ROLES.max, '收到评审结论，按风险清单修复。', 400)
    await a.tool(ROLES.max, fix, 'edit', { path: 'src/index/store.ts' }, 'updated 1 file: 锁外提交', 360)
    await a.model(ROLES.max, 'STATUS: PASS｜已修复并自测通过。', 400)
    await a.settle()
  },
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
