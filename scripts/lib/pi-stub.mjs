export const PI_STUB_SCRIPT = `
(() => {
  let cbId = 0
  const projects = [
    { id: 'p-flow-a', name: '产品需求全流程', path: null, archived: false, updated_at: Date.now() - 3 * 86_400_000 },
    { id: 'p-flow-b', name: 'pi-workbench', path: '/Users/tatsuma/Documents/GIT/pi-workbench', archived: false, updated_at: Date.now() - 2 * 3_600_000 },
  ]
  window.__PI_STUB__ = { calls: [], argCalls: [], rpcTypes: [], emitted: [], bound: null, replayMode: !!window.__PI_REPLAY_MODE__, scripted: !!window.__PI_SCRIPTED__, slow: !!window.__PI_SLOW__, listeners: {}, lastSent: '', q: { steering: [], followUp: [] }, experts: [], drafts: {}, wi: [], active: (window.__PI_REPLAY_ACTIVE__ || window.__PI_SCRIPTED__) ? 'p-flow-b' : null, connSel: [], connectors: [
    { id: 'c-github', title: 'GitHub', description: '仓库与 PR', server_name: 'github', transport: 'streamable-http', enabled: true, state: 'ready', tool_names: ['mcp__github__list_prs', 'mcp__github__get_file'], tool_count: 2 },
    { id: 'c-notion', title: 'Notion', description: '页面与数据库', server_name: 'notion', transport: 'stdio', enabled: true, state: 'ready', tool_names: ['mcp__notion__search'], tool_count: 1 },
  ], exts: [
    { id: 'agent-codebase.ts', name: '代码库索引', description: '为项目建图并支持对话检索', kind: 'tool', path: '/cfg/extensions/agent-codebase.ts', tools: ['codebase_search'], enabled: true, loaded: true, removable: false },
    { id: 'agent-memory.ts', name: '长期记忆', description: '把对话要点追加进 .pi/memory', kind: 'tool', path: '/cfg/extensions/agent-memory.ts', tools: ['memory_store'], enabled: true, loaded: true, removable: false },
    { id: 'agent-browser-session.ts', name: '浏览器会话', description: '开真实浏览器并维护会话状态', kind: 'tool', path: '/cfg/extensions/agent-browser-session.ts', tools: ['browser_open'], enabled: false, loaded: true, removable: false },
    { id: 'from-url.ts', name: '链接安装的扩展', description: '从直链安装的第三方扩展', kind: 'tool', path: '/cfg/extensions/from-url.ts', tools: ['custom_tool'], enabled: true, loaded: true, removable: true },
  ], pkgs: [
    { source: 'npm:pi-web-access', installed_path: '/cfg/npm/node_modules/pi-web-access', scope: 'user' },
    { source: 'github.com/nicobailon/pi-subagents', installed_path: '/cfg/git/github.com/nicobailon/pi-subagents', scope: 'user' },
  ], pkgUpdatesAvailable: [
    { source: 'npm:pi-web-access', kind: 'npm', current: '0.47.0', latest: '0.48.0' },
  ] }
  // 字段完整性自检（AUDIT-001 回归）：漏字段立刻抛明确错误，
  // 而不是等 emitPi 用到时才静默崩在半路（Cannot read properties of undefined）。
  ;(() => {
    const required = ['calls', 'rpcTypes', 'emitted', 'listeners', 'q']
    for (const k of required) {
      if (!(k in window.__PI_STUB__)) {
        throw new Error('__PI_STUB__ 初始化缺字段 "' + k + '"：stub 契约被破坏，请补上再跑')
      }
    }
  })()
  // 事件插件退订时要回调这个内部对象；不打桩会在「离开对话页」时抛
  // unregisterListener of undefined —— 又是空桩自己造出来的假崩溃。
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {}, registerListener() {} }
  // 非 scripted 页（page2 主流程）不会自动收尾——真实内核每条 prompt 必发
  // agent_settled，这里给测试一个手动收尾入口，避免 streaming 卡死掩盖后续路径。
  window.__PI_STUB__.emitSettled = function () {
    emitPi({ type: 'agent_settled' })
  }
  // 压测钩子：轨迹面板要验证「300 条调用」这种真实体量，需从外部灌事件。
  window.__PI_STUB__.emitPi = emitPi
  // 通用 Tauri 事件入口：非 pi://event 的窗口级事件（M10 拖拽的 tauri://drag-*）
  // 走的也是 plugin:event|listen 注册，按事件名反查 handler 回调即可。
  // payload 形状对齐原生协议：drag-enter/drop 带 { paths, position }，drag-leave 无载荷。
  window.__PI_STUB__.emitTauri = function (event, payload) {
    const ids = window.__PI_STUB__.listeners[event] || []
    window.__PI_STUB__.tauriEvents = (window.__PI_STUB__.tauriEvents ?? []).concat(event)
    for (const id of ids) {
      const fn = window['_' + id]
      if (fn) fn({ event, payload, id: 0 })
    }
  }
  // #66 M8 握手钩子：设定连接器状态面 + 前 N 次 connectors_list 仍返回 discovering，
  // 之后收敛到 settled——模拟真实启动「先握手中、几十毫秒后就绪」的收敛过程，
  // 让 McpProgressStrip 的连接态/就绪态/消失行为都可断言。
  window.__PI_STUB__.setConnStates = function (states, pendingPolls) {
    const base = window.__PI_STUB__.connectors ?? []
    window.__PI_STUB__.settled = base.map((c) => (states[c.id] ? { ...c, state: states[c.id] } : { ...c }))
    window.__PI_STUB__.connPend = pendingPolls ?? 0
  }
  // 种子入口：必须在 app 启动前设定（进度条挂载即首轮轮询，来不及事后改）。
  if (window.__PI_SEED_CONNS__) window.__PI_STUB__.setConnStates(window.__PI_SEED_CONNS__.states, window.__PI_SEED_CONNS__.pending)
  // G5 桩内事件发射：listen 的 handler 经 transformCallback 注册在 window['_'+id]，
  // 反向调用即「内核推了一条 pi://event」。scripted 流程的 assistant 回复靠它。
  function emitPi(rec) {
    const ids = window.__PI_STUB__.listeners['pi://event'] || []
    window.__PI_STUB__.emitted.push(rec.type)
    for (const id of ids) {
      const fn = window['_' + id]
      if (fn) fn({ event: 'pi://event', payload: rec, id: 0 })
    }
  }
  // scripted 回复：带计划指令前缀 → 编号分步计划；执行 prompt → 执行汇报；其他 → 普通回复。
  // 只发一条 message_update（增量语义下的完整文本），避开 60ms 节流丢中间 delta。
  // 时序必须模仿真实内核：message_end / agent_settled 要等节流把 text_delta 落下去之后再发，
  // 否则 usage 挂不到消息、agent_settled 也收不了 streaming（实测：同步全发会卡在「执行中」）。
  // slow 模式（G6 队列用）：首轮 1.4s 才 settled，留出 streaming 窗口发第二条。
  function replyScripted(body) {
    const text = String(body).includes('[计划模式]')
      ? '好的，先出计划不动手。计划如下：\\n1. 定位索引死锁根因（持锁调 save 重入）\\n2. 改成锁外调用并补回归测试\\n3. 跑全量测试确认无回归'
      : String(body).includes('计划已确认')
        ? '已按批准的计划执行：修改完成，测试通过。'
        : '收到，已处理。'
    const usage = { input: 120, output: 42, cacheRead: 0, cacheWrite: 0, totalTokens: 162, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
    // 链路信封：桥侧 pi_run 会给每条事件补 runId/spanId/起止时间，
    // 这里按同一形状补上，测试界面走的就不是「老事件降级路径」。
    const stub = window.__PI_STUB__
    const n = (stub.runs = (stub.runs ?? 0) + 1)
    const runId = 'run-test-' + n
    const t0 = Date.now()
    const turnId = 'turn-' + n
    const modelId = 'model-' + n
    if (!stub.kernelSent) {
      stub.kernelSent = true
      emitPi({ type: 'kernel_start', agentId: 'main', pid: 4242, extensions: ['agent-tool-gate', 'agent-teams'], cwd: '/tmp/flow-demo-repo', pi_ts: t0 - 500 })
    }
    emitPi({ type: 'run_start', runId, agentId: 'main', runStartedAt: t0, prompt: String(body).slice(0, 160), pi_ts: t0 })
    emitPi({ type: 'turn_start', runId, agentId: 'main', spanId: turnId, spanKind: 'turn', spanStartedAt: t0 + 1, pi_ts: t0 + 1 })
    setTimeout(() => {
      emitPi({ type: 'message_start', message: { role: 'assistant', content: [] }, runId, agentId: 'main', spanId: modelId, parentSpanId: turnId, spanKind: 'model', spanStartedAt: t0 + 120, pi_ts: t0 + 120 })
      emitPi({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text }, usage, runId, agentId: 'main', spanId: modelId, parentSpanId: turnId, spanKind: 'model', spanStartedAt: t0 + 120, pi_ts: t0 + 130 })
    }, 120)
    // 普通回复里塞一次失败的工具调用：验证「失败环节标红」与独立状态，不混进「完成」。
    if (text === '收到，已处理。') {
      setTimeout(() => {
        emitPi({ type: 'tool_execution_start', toolCallId: 'c-' + n, toolName: 'bash', args: { command: 'pnpm test -- --runInBand' }, runId, agentId: 'main', spanId: 'tool-' + n, parentSpanId: modelId, spanKind: 'tool', spanStartedAt: t0 + 150, pi_ts: t0 + 150 })
      }, 150)
      // 内核 0.87.x 实证形状：失败输出 = 正文 + 空行 + Command exited with code N
      setTimeout(() => {
        emitPi({ type: 'tool_execution_end', toolCallId: 'c-' + n, toolName: 'bash', isError: true, result: { content: [{ type: 'text', text: 'FAIL tests/x.spec.ts\\n\\nCommand exited with code 1' }] }, runId, agentId: 'main', spanId: 'tool-' + n, parentSpanId: modelId, spanKind: 'tool', spanStartedAt: t0 + 150, spanEndedAt: t0 + 210, pi_ts: t0 + 210 })
      }, 210)
    }
    setTimeout(() => {
      emitPi({ type: 'message_end', message: { role: 'assistant', content: [], usage }, runId, agentId: 'main', spanId: modelId, parentSpanId: turnId, spanKind: 'model', spanStartedAt: t0 + 120, spanEndedAt: t0 + 260, pi_ts: t0 + 260 })
      emitPi({ type: 'agent_settled', runId, agentId: 'main', spanId: turnId, spanKind: 'turn', spanStartedAt: t0 + 1, spanEndedAt: t0 + 262, runEndedAt: t0 + 262, runStatus: 'ok', pi_ts: t0 + 262 })
      deliverQueue()
    }, window.__PI_STUB__.slow ? 4000 : 320)
  }
  // 队列消费（模仿内核语义：steer 优先于 followUp——插话在下次 LLM 调用前注入，
  // followUp 在本轮完全结束后才交付）。每条交付都回推 queue_update + user 消息 + 简短回复。
  function deliverQueue() {
    const q = window.__PI_STUB__.q
    const next = q.steering.length ? q.steering.shift() : q.followUp.length ? q.followUp.shift() : null
    emitPi({ type: 'queue_update', steering: q.steering, followUp: q.followUp })
    if (next == null) return
    setTimeout(() => {
      const usage = { input: 80, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
      emitPi({ type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: next }] } })
      emitPi({ type: 'message_start', message: { role: 'assistant', content: [] } })
      emitPi({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '已处理：' + next }, usage })
      setTimeout(() => {
        emitPi({ type: 'message_end', message: { role: 'assistant', content: [], usage } })
        emitPi({ type: 'agent_settled' })
        deliverQueue()
      }, 250)
    }, 60)
  }
  window.__TAURI_INTERNALS__ = {
    transformCallback(cb, once) {
      const id = ++cbId
      Object.defineProperty(window, '_' + id, { value: (...a) => { if (once) delete window['_' + id]; cb(...a) }, writable: true, configurable: true })
      return id
    },
    convertFileSrc: (s) => s,
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    invoke(cmd, args) {
      window.__PI_STUB__.calls.push(cmd)
      window.__PI_STUB__.argCalls.push({ cmd, args })
      // pi_call 是 RPC 统一入口：把行内 type 也记下来，断言才能说清
      // 「follow_up / steer 被调用了」（calls 里只有 pi_call 这个壳）。
      if (cmd === 'pi_call') {
        try {
          window.__PI_STUB__.rpcTypes.push(JSON.parse(args.json).type)
        } catch {}
      }
      const r = (v) => Promise.resolve(v)
      if (cmd === 'projects_list') return r(projects)
      if (cmd === 'project_active') return r(window.__PI_STUB__.active ?? null)
      if (cmd === 'project_set_active') { window.__PI_STUB__.active = args.id; return r(null) }
      if (cmd === 'project_set_path') {
        const p = projects.find((x) => x.id === args.id)
        if (p) p.path = args.path
        window.__PI_STUB__.bound = { id: args.id, path: args.path }
        return r(null)
      }
      // 项目工作台要真实快照形状：空桩会让它渲染成「项目不存在」，
      // 那样断言的是「空桩没炸」，而不是「工具面真的挂上了」。
      // 项目快照统一从这里出：工作项是可变态（灌种子 / 增改删都要回显），
      // 三个命令共用一份形状，断言测到的才是视图真实分支。
      const projectSnapshot = (id) => {
        const p = projects.find((x) => x.id === id) || projects[0]
        return {
          project: { ...p, description: '本地工作目录', archived: false, updated_at: Date.now() },
          config: {
            id: 'cfg-flow',
            project_id: p.id,
            number: 3,
            instruction: '保持最小改动',
            capabilities: [],
            created_by: 'me',
            created_at: Date.now(),
          },
          work_items: window.__PI_STUB__.wi,
          assets: [],
          tasks: [],
          activity: [],
          instruction_usage: { tokens: 120, budget: 4000 },
        }
      }
      if (cmd === 'project_get') return r(projectSnapshot(args.id))
      if (cmd === 'project_add_work_item') {
        const now = Date.now()
        window.__PI_STUB__.wi.push({
          id: 'wi-' + window.__PI_STUB__.wi.length,
          project_id: args.id,
          title: args.title,
          status: 'todo',
          assignee: '',
          priority: 'p2',
          tags: [],
          revision: 'r' + now,
          created_at: now,
          updated_at: now,
        })
        return r(projectSnapshot(args.id))
      }
      if (cmd === 'project_update_work_item') {
        const wi = window.__PI_STUB__.wi.find((x) => x.id === args.patch.id)
        if (!wi) return Promise.reject('工作项不存在')
        // 乐观锁：过期修订必须拒——这是内核真语义，桩不能装死。
        if (args.expected_revision && wi.revision !== args.expected_revision) {
          return Promise.reject('revision conflict')
        }
        Object.assign(wi, args.patch, { revision: 'r' + Date.now(), updated_at: Date.now() })
        return r(projectSnapshot(args.id))
      }
      if (cmd === 'project_remove_work_item') {
        window.__PI_STUB__.wi = window.__PI_STUB__.wi.filter((x) => x.id !== args.work_item_id)
        return r(projectSnapshot(args.id))
      }
      if (cmd === 'plugin:dialog|open') return r('/tmp/flow-demo-repo')
      // 这几个命令在真实后端返回数组/对象；打桩必须给同样的形状，
      // 否则空桩自己会造出 null.length，把真缺陷淹掉。
      // 角色清单给真实内置形状（与 roles.rs::builtin_roles 同构）：
      // 空桩会让「+」菜单角色行的有数据分支永远测不到。
      if (cmd === 'role_list') return r([
        { id: 'general', name: '通用助手', description: '默认人格：先确认边界再给方案。', prompt: '…' },
        { id: 'aider-programmer', name: 'Aider 编程专家', description: '最小 diff、测试驱动的编程搭档。', prompt: '…' },
      ])
      if (cmd === 'role_current') return r({ id: window.__PI_STUB__.roleId ?? 'general', name: window.__PI_STUB__.roleId === 'aider-programmer' ? 'Aider 编程专家' : '通用助手', description: '', prompt: '' })
      if (cmd === 'role_set') {
        window.__PI_STUB__.roleId = args.id
        // 真后端返回角色全名，不是 id：桩若回 id 会让「主列角色值」断言失真。
        const names = { general: '通用助手', 'aider-programmer': 'Aider 编程专家' }
        return r({ id: args.id, name: names[args.id] ?? args.id, description: '', prompt: '' })
      }
      if (cmd === 'fs_read_dir') return r([])
      if (cmd === 'fs_read_file') return r('')
      if (cmd === 'settings_load') return r({ models: [] })
      // Worktree 引擎：真实后端返回 Vec/结构体，给同样形状（含脏改动分支），
      // 让工作区面板在回归里真的渲染出卡片，而不是空态。
      if (cmd === 'wt_list')
        return r([
          {
            branch: 'main',
            path: '/Users/tatsuma/Documents/GIT/pi-workbench',
            is_main: true,
            dirty: 0,
            ahead: 0,
            behind: 0,
            base: 'main',
            last_commit: 'chore: sync worktree engine',
            last_commit_at: Math.floor(Date.now() / 1000) - 3600,
            port: 30000,
          },
          {
            branch: 'feat/pi-kernel',
            path: '/Users/tatsuma/Documents/GIT/pi-workbench.feat-pi-kernel',
            is_main: false,
            dirty: 2,
            ahead: 3,
            behind: 0,
            base: 'main',
            last_commit: 'feat: per-worktree pi session',
            last_commit_at: Math.floor(Date.now() / 1000) - 600,
            port: 30471,
          },
        ])
      if (cmd === 'wt_diff')
        return r({
          files: [
            { path: 'src-tauri/src/worktrees.rs', adds: 42, dels: 3 },
            { path: 'src/components/worktrees/WorktreePanel.vue', adds: 18, dels: 0 },
          ],
          commits: ['feat: per-worktree pi session', 'feat: worktree engine'],
        })
      if (cmd === 'wt_create') return r({ branch: args.branch, path: '/tmp/' + args.branch })
      if (cmd === 'wt_merge') return r({ steps: ['✓ squash 合并 feat/pi-kernel → main'], cleaned: true })
      if (cmd === 'wt_remove') return r(null)
      // 舰队看板：一次派发 N 条 lane；流 id = <fleet>:<安全分支名>，
      // 与真实后端同一形状，看板断言才测得到「有 lane」的分支。
      if (cmd === 'wt_fleet_launch') {
        const fid = args.fleetId || 'fleet-stub'
        const now = Math.floor(Date.now() / 1000)
        const lanes = (args.launch?.branches ?? []).map((b) => ({
          branch: b,
          path: '/tmp/wt.' + b.replace(/[^a-zA-Z0-9._-]/g, '-'),
          id: fid + ':' + b.replace(/[^a-zA-Z0-9._-]/g, '-'),
          status: 'running',
          exit_code: null,
          started_at: now,
          ended_at: null,
        }))
        const run = { id: fid, task: args.launch?.task ?? '', agent: args.launch?.agent ?? 'pi', lanes, created_at: now, updated_at: now }
        window.__PI_STUB__.fleets = [run, ...(window.__PI_STUB__.fleets ?? [])]
        return r(run)
      }
      if (cmd === 'wt_fleet_list') {
        // 回放一条历史舰队：一条 done、一条 failed，验证状态徽章分支。
        const now = Math.floor(Date.now() / 1000)
        return r([
          {
            id: 'fleet-demo-1',
            task: '给轨迹面板补空态',
            agent: 'pi',
            lanes: [
              { branch: 'task-1', path: '/tmp/wt.task-1', id: 'fleet-demo-1:task-1', status: 'done', exit_code: 0, started_at: now - 300, ended_at: now - 120 },
              { branch: 'task-2', path: '/tmp/wt.task-2', id: 'fleet-demo-1:task-2', status: 'failed', exit_code: 1, started_at: now - 300, ended_at: now - 100 },
            ],
            created_at: now - 300,
            updated_at: now - 100,
          },
          ...(window.__PI_STUB__.fleets ?? []),
        ])
      }
      // 合并冲突预测：一对 high（行相撞）+ 一对 medium（同文件）。
      if (cmd === 'wt_conflicts')
        return r([
          { a: 'task-1', b: 'task-2', file: 'src/components/chat/TracePanel.vue', lines: [[120, 138]], level: 'high' },
          { a: 'task-1', b: 'task-3', file: 'src/composables/usePi.ts', lines: [], level: 'medium' },
        ])
      // 其余列表类命令：真实后端返回数组，桩也给数组（空壳返回 null 会自己造出
      // null.length，把真缺陷淹掉）。
      if (cmd === 'local_models_list') return r([])
      if (cmd === 'local_models_catalog') return r([])
      if (cmd === 'local_downloads') return r([])
      if (cmd === 'mcp_list') return r([])
      // 后台与启动：真实后端返回 BackgroundInfo，null 会让设置页后台分区渲染崩掉。
      if (cmd === 'background_get' || cmd === 'background_set_close_action' || cmd === 'background_set_paused')
        return r({ close_action: 'ask', paused: false, autostart: false })
      if (cmd === 'background_set_autostart') return r(false)
      // 内核自检：桌面进程 PATH 里常没有 pi，设置页要显示探测结果。
      if (cmd === 'pi_doctor') return r({ found: true, path: '/opt/homebrew/bin/pi', probed: 12, error: null })
      // 发消息：failSend 打开时模拟「内核未启动」，用来验证失败不是静默的。
      if (cmd === 'pi_note_user') return r(null)
      if (cmd === 'pi_send') {
        if (window.__PI_STUB__.failSend) return Promise.reject('pi 未启动')
        let type = ''
        let body = ''
        try {
          const req = JSON.parse(args.json)
          type = req.type ?? ''
          body = req.message ?? ''
        } catch {}
        // G6：follow_up / steer 走 pi_send 下发（与真实后端同一通道）。
        // 桩同样立刻回推 queue_update——chip 以内核回推为权威，不本地维护副账。
        if (type === 'follow_up' || type === 'steer') {
          const q = window.__PI_STUB__.q
          if (type === 'follow_up') q.followUp.push(body)
          else q.steering.push(body)
          window.__PI_STUB__.lastQueued = body
          window.__PI_STUB__.rpcTypes.push(type)
          emitPi({ type: 'queue_update', steering: q.steering, followUp: q.followUp })
          return r(null)
        }
        // scripted 模式：记下发的正文，并按内容推一轮流式回复（G5 plan 流程用）。
        if (window.__PI_STUB__.scripted) {
          window.__PI_STUB__.lastSent = body
          replyScripted(body)
        }
        return r(null)
      }
      // G3 checkpoint：开轮返回递增 seq；rewind 回一份真实形状的报告。
      if (cmd === 'checkpoint_begin_turn') {
        window.__PI_STUB__.turnSeq = (window.__PI_STUB__.turnSeq ?? 0) + 1
        return r(window.__PI_STUB__.turnSeq)
      }
      // G6 队列走 pi_call 统一入口：follow_up 入队（本轮结束执行）/
      // steer 插话（下次 LLM 调用前注入）。都立刻回推 queue_update——
      // 前端 chip 以内核回推为权威，不本地维护副账。
      if (cmd === 'pi_call') {
        let type = ''
        let body = ''
        try {
          const req = JSON.parse(args.json)
          type = req.type ?? ''
          body = req.message ?? ''
        } catch {}
        if (type === 'follow_up' || type === 'steer') {
          const q = window.__PI_STUB__.q
          if (type === 'follow_up') q.followUp.push(body)
          else q.steering.push(body)
          window.__PI_STUB__.lastQueued = body
          emitPi({ type: 'queue_update', steering: q.steering, followUp: q.followUp })
          return r(null)
        }
        if (type === 'clear_queue') {
          const cleared = { steering: window.__PI_STUB__.q.steering, followUp: window.__PI_STUB__.q.followUp }
          window.__PI_STUB__.q = { steering: [], followUp: [] }
          emitPi({ type: 'queue_update', steering: [], followUp: [] })
          return r(cleared)
        }
        // #100 会话树：get_tree 返回一棵带分叉的小树；fork 记录落点并回 null。
        // 树形对齐内核 SessionTreeNode：e1(user) 下挂 e2(assistant) 与 e3(user) 两个
        // 同层分支，e3 再挂 e4(assistant) 作 leaf——用来断言 user-only 分叉约束。
        if (type === 'get_tree') {
          const msg = (id, role, text, ts) => ({ id, type: 'message', parentId: null, timestamp: ts, message: { role, content: text } })
          const tree = [
            {
              entry: msg('e1', 'user', '第一个问题', '2026-11-23T10:00:00.000Z'),
              children: [
                { entry: msg('e2', 'assistant', '回答甲', '2026-11-23T10:00:05.000Z'), children: [] },
                {
                  entry: msg('e3', 'user', '分叉出来的第二个问题', '2026-11-23T10:01:00.000Z'),
                  children: [{ entry: msg('e4', 'assistant', '回答乙', '2026-11-23T10:01:06.000Z'), children: [] }],
                },
              ],
            },
          ]
          return r({ tree, leafId: 'e4' })
        }
        if (type === 'fork') {
          // entryId 在请求体里（req 是 try 块局部，这里重新解析）
          let entryId = null
          try {
            entryId = JSON.parse(args.json).entryId ?? null
          } catch {}
          ;(window.__PI_STUB__.forkCalls ??= []).push(entryId)
          return r(null)
        }
      }
      if (cmd === 'checkpoint_rewind') {
        window.__PI_STUB__.rewound = args
        // #67 失败路径：编辑重开/刷新末条的回滚 rejection 要落进消息流
        //（「对话编辑失败/对话重发失败」），不能只在控制台飘一下。
        if (window.__PI_STUB__.failRewind) return Promise.reject('checkpoint 不可用')
        return r({
          seq: args.seq,
          restored: [{ path: '/Users/tatsuma/Documents/GIT/pi-workbench/src/demo.ts', from_seq: args.seq }],
          removed: [{ path: '/Users/tatsuma/Documents/GIT/pi-workbench/src/newborn.ts', from_seq: args.seq }],
          failed: [],
          fork_entry_id: 'entry-abc',
        })
      }
      // #76 M3：回退前 dry-run——桩返回固定形状（还原 2 + 删除 1），
      // 确认框的分类渲染按这个形状断言。
      if (cmd === 'checkpoint_preview') {
        window.__PI_STUB__.previewed = args
        return r({
          seq: args.seq,
          restore: [
            { path: '/proj/src/auth.ts', from_seq: args.seq },
            { path: '/proj/src/db.ts', from_seq: args.seq + 1 },
          ],
          delete: [{ path: '/proj/scripts/gen.ts', from_seq: args.seq + 1 }],
          failed: [],
        })
      }
      if (typeof cmd === 'string' && cmd.startsWith('plugin:event|')) {
        // G5：捕获事件监听 handler——桩要能反向推流式事件（plan 流程的 assistant 回复）。
        if (cmd === 'plugin:event|listen' && args && args.handler) {
          const list = (window.__PI_STUB__.listeners[args.event] ??= [])
          if (!list.includes(args.handler)) list.push(args.handler)
          return r(args.handler)
        }
        // unlisten 必须真的摘除：否则组件反复挂载（路由来回切）会累积僵尸回调，
        // 一次 emitTauri 打多份 attachment_add，断言数字全是假的。
        if (cmd === 'plugin:event|unlisten' && args && args.eventId != null) {
          for (const ev of Object.keys(window.__PI_STUB__.listeners)) {
            const list = window.__PI_STUB__.listeners[ev]
            const i = list.indexOf(args.eventId)
            if (i >= 0) list.splice(i, 1)
          }
          return r(null)
        }
        return r(0)
      }
      if (typeof cmd === 'string' && cmd.includes('|listen')) return r(0)
      // ── 已有功能「真跑通」验证：返回真实形状的清单数据，证明 UI 接到的是真结构而非空壳 ──
      if (cmd === 'extensions_list') return r(window.__PI_STUB__.exts.map((e) => ({ ...e })))
      // #78 加载开关 / 卸载：桩维护同一份内存状态，让 UI 收敛可见。
      if (cmd === 'extensions_set_enabled') {
        const ext = window.__PI_STUB__.exts.find((e) => e.id === args.id)
        if (ext) { ext.loaded = args.enabled; ext.enabled = args.enabled && ext.tools.length > 0 }
        ;(window.__PI_STUB__.extToggles ??= []).push({ id: args.id, enabled: args.enabled })
        return r(window.__PI_STUB__.exts.map((e) => ({ ...e })))
      }
      if (cmd === 'extensions_remove') {
        window.__PI_STUB__.exts = window.__PI_STUB__.exts.filter((e) => e.id !== args.id)
        ;(window.__PI_STUB__.extRemoved ??= []).push(args.id)
        return r(window.__PI_STUB__.exts.map((e) => ({ ...e })))
      }
      // #96 Pi 托管包透传：桩维护一份内存清单，语义与 pi list/install/remove/update 对齐。
      if (cmd === 'pi_pkg_list') return r((window.__PI_STUB__.pkgs ?? []).map((p) => ({ ...p })))
      if (cmd === 'pi_pkg_install') {
        ;(window.__PI_STUB__.pkgInstalls ??= []).push(args.source)
        if (!window.__PI_STUB__.pkgs) window.__PI_STUB__.pkgs = []
        if (!window.__PI_STUB__.pkgs.some((p) => p.source === args.source)) {
          window.__PI_STUB__.pkgs.push({ source: args.source, installed_path: '/stub/agent/' + args.source, scope: 'user' })
        }
        return r('Installed ' + args.source)
      }
      if (cmd === 'pi_pkg_remove') {
        ;(window.__PI_STUB__.pkgRemoves ??= []).push(args.source)
        window.__PI_STUB__.pkgs = (window.__PI_STUB__.pkgs ?? []).filter((p) => p.source !== args.source)
        return r('Removed ' + args.source)
      }
      if (cmd === 'pi_pkg_update_one') {
        ;(window.__PI_STUB__.pkgUpdates ??= []).push(args.source)
        return r('Updated ' + args.source)
      }
      if (cmd === 'pi_pkg_update_all') {
        ;(window.__PI_STUB__.pkgUpdates ??= []).push('*')
        return r('Updated packages')
      }
      if (cmd === 'pi_pkg_check_updates') {
        return r((window.__PI_STUB__.pkgUpdatesAvailable ?? []).map((u) => ({ ...u })))
      }
      if (cmd === 'library_list') return r([
        { id: 'a1', name: '会议纪要.md', rel_path: '/docs/会议纪要.md', kind: 'markdown', dir: '/docs', origin: { kind: 'local' }, enabled: true, searchable: true, draft: false, revision: 2, size: 2048, updated_at: Date.now() },
        { id: 'a2', name: '需求.doc', rel_path: '/docs/需求.doc', kind: 'docx', dir: '/docs', origin: { kind: 'import' }, enabled: true, searchable: true, draft: false, revision: 1, size: 4096, updated_at: Date.now() },
      ])
      if (cmd === 'library_stats') return r({ asset_count: 2, used_bytes: 6144, max_file_bytes: 52428800, max_total_bytes: 104857600 })
      // 失败批次：真实后端返回空数组。返回 null 会让「空值归一化」缺失时整页崩掉，
      // 掩盖掉目录树和配额卡的其它缺陷。
      if (cmd === 'library_archive_failures') return r([])
      // 记忆层：给空清单与未建索引状态，验证空态/骨架切换而不是永久骨架。
      if (cmd === 'agent_memory_list') return r([])
      if (cmd === 'agent_memory_trash') return r([])
      if (cmd === 'agent_profile_get') return r({ generated_at: 0, source_mtime: 0 })
      if (cmd === 'memory_vec_status') return r({ table: 'memory_vectors', exists: false, rows: 0, embedding: { base_url: '', model: '' }, agent_tool_note: '' })
      if (cmd === 'library_tree') return r([ { path: '/', name: '', is_dir: true, asset_id: null }, { path: '/docs', name: 'docs', is_dir: true, asset_id: null }, { path: '/docs/会议纪要.md', name: '会议纪要.md', is_dir: false, asset_id: 'a1' } ])
      if (cmd === 'library_marks') return r([ { id: 'a1', name: '会议纪要.md', dir: '/docs' } ])
      if (cmd === 'library_search') return r([ { asset_id: 'a1', name: '会议纪要.md', dir: '/docs', kind: 'markdown', origin: { kind: 'local' }, revision: 2, location: '摘要', snippet: '本次会议决定了…', convert_status: 'ready' } ])
      if (cmd === 'skills_list') return r([ { name: 'pdf', description: 'PDF 读写与转换', kind: 'skill', path: '/skills/pdf', via: 'local', scope: 'user', origin: 'local' }, { name: 'docx', description: 'Word 文档处理', kind: 'skill', path: '/skills/docx', via: 'local', scope: 'user', origin: 'local' } ])
      // 专家域：清单可变，用来验证「新建 → 表单 → 保存 → 列表回显」整条链路。
      // 返新数组：与 Vue ref 里的数组保持不同引用，否则同一实例的 push 不触发重渲染。
      if (cmd === 'experts_list') return r(window.__PI_STUB__.experts.map((e) => ({ ...e })))
      if (cmd === 'tools_list') return r({
        active: [],
        catalog: ['read', 'edit', 'write', 'bash', 'grep', 'glob', 'codebase_search', 'web_search'],
        settings_path: '/tmp/flow-demo-repo/.pi/settings.json',
      })
      if (cmd === 'expert_draft_load') return r(window.__PI_STUB__.drafts[args.id] ?? null)
      if (cmd === 'expert_validate') return r([])
      // persona 预览：后端编译的唯一真源，桩按同一形状返回（含硬规则段与反废话标记）。
      if (cmd === 'expert_persona_preview') {
        const d = args.definition ?? {}
        const prefix = '你是「' + (d.name || '') + '」。'
        const suffix = (d.rules || '').trim() ? '\\n\\n## 硬规则\\n' + d.rules.trim() : ''
        return r({
          prefix,
          suffix,
          full: prefix + '\\n\\n## 角色定位\\n' + (d.role || '') + suffix,
          executor: d.executor ?? null,
          model: d.model ?? null,
          mcp_servers: d.mcp_servers ?? [],
          skill_names: (d.skill_requirements ?? []).map((s) => s.name).filter(Boolean),
          allowed_tools: d.allowed_tools ?? [],
          denied_patterns: d.denied_patterns ?? [],
          max_iterations: d.max_iterations ?? null,
          terse_enforced: true,
        })
      }
      if (cmd === 'expert_draft_save') {
        const draft = { definition: args.definition, revision: 1, digest: 'd'.repeat(16), updated_at: Date.now() }
        window.__PI_STUB__.drafts[args.id] = draft
        const rows = window.__PI_STUB__.experts
        const row = {
          id: args.id,
          name: args.definition.name,
          description: args.definition.description,
          role: args.definition.role,
          tags: args.definition.tags || [],
          published: false,
          draft_revision: 1,
          digest: draft.digest,
          tool_count: (args.definition.allowed_tools || []).length,
          last_run: { run_id: 'run-e1', status: 'ok', at: Date.now() - 60_000 },
        }
        const i = rows.findIndex((e) => e.id === args.id)
        if (i >= 0) rows[i] = row
        else rows.push(row)
        return r(draft)
      }
      if (cmd === 'expert_delete') {
        window.__PI_STUB__.experts = window.__PI_STUB__.experts.filter((e) => e.id !== args.id)
        delete window.__PI_STUB__.drafts[args.id]
        return r(null)
      }
      // WorkBuddy 缓存扫描导入：一个团队包 + 一个单人包 + 一个坏包（error 分支要测得到）。
      // 形状对齐后端 ScanPackage / ImportExpertPreview。
      const scanExpert = (id, name, tools, unmapped_tools = []) => ({
        id, name, role: '只读审查，不改代码。',
        definition: {
          name, description: id + ' 描述', role: '只读审查，不改代码。',
          methodology: '先看 diff', boundaries: '不碰生产', deliverables: '清单',
          tags: [], examples: [], skill_requirements: [],
          allowed_tools: tools, denied_patterns: [], stop_condition: '给出结论即停',
          max_iterations: null, tool_mapping: [], executor: null, model: null,
          rules: '', mcp_servers: [],
        },
        source_path: '/cache/' + id + '.md', conflict: false,
        unmapped_tools, unmapped_fields: [], warnings: [],
      })
      if (cmd === 'expert_import_scan') {
        const packages = [
          {
            slug: 'code-crew', name: '代码之舟', version: '1.0.0',
            path: '/Users/test/.workbuddy/plugins/cache/experts/code-crew/1.0.0',
            is_team: true, lead: 'code-crew-team-lead',
            member_ids: ['code-crew-team-lead', 'code-crew-first-engineer'],
            experts: [scanExpert('code-crew-team-lead', '团队牵头人', ['read', 'grep']), scanExpert('code-crew-first-engineer', '主任工程师', ['read', 'edit'])],
            conflict: false, error: null,
          },
          {
            slug: 'solo-reviewer', name: '独立评审员', version: '2.1.0',
            path: '/Users/test/.workbuddy/plugins/cache/experts/solo-reviewer/2.1.0',
            is_team: false, lead: null, member_ids: [],
            // Read 有建议（自动采纳）；Grep/Glob 内核无同名工具、无建议——前端应默认忽略
            // 而不是留「待决定」把导入按钮卡死（截图里用户看不懂选什么）。
            experts: [scanExpert('solo-reviewer', '独立评审员', ['read'], [
              { name: 'Read', suggestion: 'read' },
              { name: 'Grep', suggestion: null },
              { name: 'Glob', suggestion: null },
            ])],
            conflict: false, error: null,
          },
          {
            slug: 'broken-pack', name: 'broken-pack', version: '1.0.0',
            path: '/Users/test/.workbuddy/plugins/cache/experts/broken-pack/1.0.0',
            is_team: false, lead: null, member_ids: [], experts: [],
            conflict: false, error: '插件清单里没有可导入的角色文件',
          },
        ]
        window.__PI_STUB__.scanPackages = packages
        return r({ root: '/Users/test/.workbuddy/plugins/cache/experts', packages })
      }
      if (cmd === 'expert_import_preview') {
        // 按路径回显对应扫描包的 experts；手填的单包路径给一条兜底。
        const pack = (window.__PI_STUB__.scanPackages ?? []).find((p) => args.path === p.path)
        const list = pack ? pack.experts : [scanExpert('manual-agent', 'manual-agent', ['read'])]
        return r({ source: args.path, plugin: 'plugin.json', unmapped_fields: [], experts: list })
      }
      if (cmd === 'expert_import_apply') {
        const out = []
        for (const item of args.items ?? []) {
          window.__PI_STUB__.drafts[item.id] = {
            definition: item.definition, revision: 1, digest: 'i'.repeat(16),
            updated_at: Date.now(), source: 'imported',
          }
          window.__PI_STUB__.experts.push({
            id: item.id, name: item.definition.name, description: item.definition.description,
            role: item.definition.role, tags: item.definition.tags || [],
            // 从 WorkBuddy 缓存导入的是成品包：已发布、可直接召唤。
            published: true, draft_revision: 1, digest: 'i'.repeat(16),
            tool_count: (item.definition.allowed_tools || []).length,
            last_run: null, source: 'imported',
          })
          out.push({ id: item.id, action: 'created', source_path: item.source_path })
        }
        return r(out)
      }
      // 连接器导入源（Cordis 归一化）：四种形态都要出现在清单里——
      // 可导入 stdio（源侧停用）、可导入 streamable-http、缺命令不可导入、与本地重名冲突。
      if (cmd === 'connectors_import_scan') {
        return r({
          root: '/Users/test/.workbuddy/mcp.json',
          candidates: [
            { server_name: 'graphify', title: 'graphify', description: '', transport: 'stdio',
              command: '/Users/test/.local/bin/graphify-mcp', args: ['--graph', '/tmp/g.json'],
              source_enabled: false, conflict: false, skip_reason: null },
            { server_name: 'team-memory', title: 'team-memory', description: '', transport: 'streamable-http',
              url: 'http://127.0.0.1:18950/mcp', source_enabled: true, conflict: false, skip_reason: null },
            { server_name: 'broken-entry', title: 'broken-entry', description: '', transport: 'stdio',
              source_enabled: true, conflict: false, skip_reason: 'connector/import-command-missing' },
            { server_name: 'codebase-memory-mcp', title: 'codebase-memory-mcp', description: '', transport: 'stdio',
              command: 'codebase-memory-mcp', source_enabled: true, conflict: true, skip_reason: null },
          ],
        })
      }
      if (cmd === 'connectors_create') {
        const created = {
          id: args.input.server_name, title: args.input.title, description: args.input.description,
          server_name: args.input.server_name, transport: args.input.transport, enabled: true,
          state: 'ready', tool_names: [], tool_count: 0,
        }
        window.__PI_STUB__.connectors = [...(window.__PI_STUB__.connectors ?? []), created]
        return r(created)
      }
      if (cmd === 'connectors_list') {
        // #66 M8：setConnStates 装过之后，前 connPend 次仍回 discovering（握手未收敛），
        // 之后回 settled——给进度条一个真实的「连接中→就绪→自毁」时间线。
        const st = window.__PI_STUB__
        if (st.settled) {
          if ((st.connPend ?? 0) > 0) {
            st.connPend -= 1
            const pend = st.settled.map((c) => (c.state === 'disabled' ? { ...c } : { ...c, state: 'discovering' }))
            return r(pend)
          }
          return r(st.settled.map((c) => ({ ...c })))
        }
        return r((window.__PI_STUB__.connectors ?? []).map((c) => ({ ...c })))
      }
      // 会话选择必须返回数组：导入出连接器后 session 区渲染 chips，null 会当场崩。
      if (cmd === 'connectors_selection') return r([...(window.__PI_STUB__.connSel ?? [])])
      // 「+」菜单连接器行的真实链路：set_selection 落选择，apply_scope 回完整白名单。
      if (cmd === 'connectors_set_selection') {
        window.__PI_STUB__.connSel = [...(args.connector_ids ?? [])]
        return r([...window.__PI_STUB__.connSel])
      }
      if (cmd === 'connectors_apply_scope') {
        const sel = window.__PI_STUB__.connSel ?? []
        const tools = (window.__PI_STUB__.connectors ?? [])
          .filter((c) => sel.includes(c.id))
          .flatMap((c) => c.tool_names ?? [])
        return r(tools)
      }
      // 智能体分道：给一份真实形状的团队 + 调度日志，空桩会让「有成员」的分支永远测不到。
      // gates / member_overrides 带上一条：关卡徽章与覆盖计数分支要测得到。
      if (cmd === 'agent_teams_list') return r([
        {
          id: 'crew-frontend',
          name: '前端专家团',
          members: ['架构师', '实现者'],
          strategy: 'sequential',
          created_at: Date.now(),
          runs: 2,
          gates: ['实现者'],
          member_overrides: { 实现者: { executor: 'claude' } },
        },
      ])
      // 待放行关卡：面板轮询这条，放行/驳回写 decision 后扩展继续。
      if (cmd === 'agent_team_gates')
        return r([
          { runId: '8f3a1c', member: '实现者', label: '实现者', team: '前端专家团', at: Date.now() - 30_000, file: 'crew-frontend.gate.json' },
        ])
      if (cmd === 'agent_team_gate_decide') {
        window.__PI_STUB__.gateDecisions = [
          ...(window.__PI_STUB__.gateDecisions ?? []),
          { team: args.team_id, member: args.member, decision: args.decision },
        ]
        return r({ member: args.member, decision: args.decision })
      }
      if (cmd === 'agent_team_create' || cmd === 'agent_team_update') {
        const entry = {
          id: cmd === 'agent_team_update' ? args.id : 'crew-new',
          name: args.name,
          members: args.members ?? [],
          strategy: args.strategy ?? null,
          lead: args.lead ?? null,
          on_failure: args.on_failure ?? null,
          gates: args.gates ?? [],
          member_overrides: args.member_overrides ?? {},
          created_at: Date.now(),
          runs: 0,
        }
        window.__PI_STUB__.teams = [entry, ...(window.__PI_STUB__.teams ?? [])]
        return r(entry)
      }
      if (cmd === 'agent_team_runs') return r([
        { run_id: '8f3a1c', strategy: 'sequential', real: true, at: Date.now() - 120000 },
        { run_id: '8f3a1c', member: '架构师', ok: true, tokens: 4200, output: '拆分为三个改动点：轨迹抽屉新增页签、分道视图、后端日志读取。', at: Date.now() - 118000 },
        { run_id: '8f3a1c', member: '实现者', ok: false, tokens: 1800, output: '类型检查失败：AgentLanes 里 payload 可能为 null。', at: Date.now() - 60000 },
        { run_id: '7c21de', strategy: 'debate', real: true, note: 'plan-only', at: Date.now() - 300000 },
      ])
      if (cmd === 'project_index_status') return r({ indexed: true, nodes: 3130, edges: 8836, project_name: 'Users-tatsuma-Documents-GIT-pi-workbench', error: null, indexing: false })
      // G4：journal 回放。多项目共用一个 events.jsonl，按 session_open 的 cwd 分段；
      // 只有 pi-workbench 段的消息应该被回放，别的项目段一条都不能出现。
      // replayMode 关时返回空——主流程断言 hero/发送链路，不能被回放消息干扰。
      if (cmd === 'pi_journal_read') {
        if (!window.__PI_STUB__.replayMode) return r([])
        return r([
          { type: 'session_open', cwd: '/tmp/other-project' },
          { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: '别的项目探过去的历史消息' }] } },
          { type: 'session_open', cwd: '/Users/tatsuma/Documents/GIT/pi-workbench' },
          { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: '[项目上下文]\\npi-workbench 的上下文\\n\\n---\\n\\n上次让我改索引' }] } },
          { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '上次的回复：索引已修好。' } },
          { type: 'message_end', message: { role: 'assistant', content: [], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } },
          { type: 'agent_settled' },
        ])
      }
      if (cmd === 'conversations_list' || cmd === 'conversation_list') return r([ { id: 'c1', title: '产品需求补全', updated_at: Date.now() } ])
      // 收件箱/定时任务：真实后端永远返回完整快照，桩缺这条会让页面渲染 null.unread 崩溃。
      if (cmd === 'proactive_snapshot') return r({ jobs: [], inbox: [], unread: 0, running_job: null, grant_usage: null })
      // 附件与窗口主题：「+」菜单添加文件 / 设置页外观切换都要走这两条，缺桩会崩。
      if (cmd === 'attachment_add') {
        const src = String(args.src ?? '')
        const name = src.split('/').pop() || 'file'
        return r({ path: '/tmp/attachments/' + name, name, size: 1024 })
      }
      // #69 M10 粘贴字节：桩按 Rust 同款形状回（托管名 + 大小），
      // 断言 paste → 托盘出图卡 的链路不依赖真 IPC。
      if (cmd === 'attachment_add_bytes') {
        const ext = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(String(args.ext ?? '').toLowerCase())
          ? String(args.ext).toLowerCase()
          : 'png'
        const name = '粘贴图片.' + ext
        return r({ path: '/tmp/attachments/' + name, name, size: 2048 })
      }
      // #66 M9 产物面：scan 按文本里的 /tmp/... 路径产卡（与 Rust 版「从会话文本抽路径」同语义），
      // read 按扩展名给文本或 data URL，save_as 记去向供断言，dialog|save 给固定去向。
      if (cmd === 'artifacts_scan') {
        const KIND = { html: 'html', htm: 'html', md: 'markdown', json: 'json', svg: 'svg', png: 'image', jpg: 'image', gif: 'image', txt: 'text' }
        const out = []
        for (const s of args.sources ?? []) {
          const seen = new Set()
          const arts = []
          // stub 整体在模板串里，正则字面量的反斜杠会被模板解析吞掉——用字符类替代 \w 与转义斜杠。
          for (const m of String(s.text ?? '').matchAll(/[/]tmp[/][A-Za-z0-9_.-]+/g)) {
            const p = m[0]
            if (seen.has(p)) continue
            seen.add(p)
            const name = p.split('/').pop() ?? p
            const ext = (name.split('.').pop() ?? '').toLowerCase()
            const kind = KIND[ext] ?? 'text'
            arts.push({ path: p, name, ext, kind, bytes: 2048, lines: 12 })
          }
          if (arts.length) out.push({ message_id: s.id, artifacts: arts })
        }
        return r(out)
      }
      if (cmd === 'artifacts_read') {
        const p = String(args.path ?? '')
        const name = p.split('/').pop() ?? ''
        const ext = (name.split('.').pop() ?? '').toLowerCase()
        const KIND = { html: 'html', htm: 'html', md: 'markdown', json: 'json', svg: 'svg', png: 'image', jpg: 'image', gif: 'image', txt: 'text' }
        const kind = KIND[ext] ?? 'text'
        const content = kind === 'image'
          ? 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
          : kind === 'html'
            ? '<!doctype html><html><body><h1>demo widget</h1><p>stub artifact body</p></body></html>'
            : kind === 'json'
              ? '{"ok":true,"rows":[1,2,3]}'
              : '# demo\\nstub artifact text'
        return r({ path: p, kind, content, truncated: false, total_bytes: content.length })
      }
      if (cmd === 'artifacts_open') { window.__PI_STUB__.opened = args.path; return r(null) }
      if (cmd === 'artifact_save_as') {
        window.__PI_STUB__.saved = { src: args.src, dest: args.dest }
        if (!String(args.src ?? '').startsWith('/tmp/')) return Promise.reject('源文件不存在：' + args.src)
        return r(null)
      }
      // plugin-dialog v2 的 save(options) 把参数裹在 { options } 里——直接读 args.defaultPath 永远是 undefined。
      if (cmd === 'plugin:dialog|save') return r('/Users/test/Downloads/' + ((args.options?.defaultPath ?? args.defaultPath ?? 'file')))
      if (cmd === 'window_set_theme') return r(null)
      return r(null)
    },
  }
})()
`
