#!/usr/bin/env node
/**
 * UI 回归验证：用本机 Chrome 渲染 `dist` 产物，对关键路由截图并做程序化几何断言。
 *
 * 为什么需要它：`vue-tsc` / `vite build` 只能证明「类型对、能打包」，
 * 证明不了「按钮没被压成方块」「下拉菜单没被挤成竖排」这类纯视觉回归。
 * 本项目真实发生过一次全局 CSS 污染（agent-ops.css 的 .tool-btn 把能力中心的
 * 带文字按钮压成 30×30），三道静态闸门全绿却没有拦住——只有真实渲染能发现。
 *
 * 用法：
 *   pnpm build && node scripts/visual-check.mjs
 *   CHROME_PATH=/path/to/chrome node scripts/visual-check.mjs   # 自定义浏览器
 *
 * 依赖：playwright-core（项目依赖或全局均可）。本机需安装 Chrome/Chromium。
 * 产物：截图写入 `.visual-check/`（已 gitignore 友好，可自行清理）。
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')
const OUT = path.join(ROOT, '.visual-check')
const PORT = Number(process.env.VISUAL_CHECK_PORT ?? 4321)

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
}

/** playwright-core 可能装在项目里，也可能装在某个全局 workspace；两处都试。 */
function loadPlaywright() {
  const tried = []
  for (const id of ['playwright-core', 'playwright']) {
    try {
      return require(id)
    } catch {
      tried.push(id)
    }
  }
  // 常见全局 workspace 回退：环境变量显式指定时也走这里。
  const extra = process.env.PLAYWRIGHT_PATH
  if (extra) {
    try {
      return require(path.join(extra, 'playwright-core'))
    } catch {
      tried.push(extra)
    }
  }
  console.error(
    `未找到 ${tried.join(' / ')}。请先安装：pnpm add -D playwright-core\n` +
      `或用 PLAYWRIGHT_PATH=<node_modules 目录> 指向已有安装。`,
  )
  process.exit(2)
}

function firstExisting(paths) {
  return paths.find((p) => {
    try {
      return fs.statSync(p).isFile()
    } catch {
      return false
    }
  })
}

function serve() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0])
    if (p === '/') p = '/index.html'
    const file = path.join(DIST, p)
    // 防目录穿越：解析后必须仍在 dist 内。
    if (!path.resolve(file).startsWith(path.resolve(DIST))) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' })
      res.end(data)
    })
  })
  return new Promise((r) => server.listen(PORT, () => r(server)))
}

/** 断言收集器：全部通过才算成功，任一失败以非零码退出，可直接接 CI。 */
const results = []
function assert(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail ?? ''}`)
}

/**
 * 读 PNG 头部拿尺寸与色彩类型（6 = RGBA，即带 alpha 通道）。
 * 应用图标是二进制产物，静态类型检查完全覆盖不到，只能直接查文件。
 */
function readPng(file) {
  try {
    const b = fs.readFileSync(file)
    if (b.readUInt32BE(0) !== 0x89504e47) return null
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), colorType: b[25] }
  } catch {
    return null
  }
}

/** 打包用的应用图标：尺寸够 + 带 alpha + icns/ico 都在。 */
function checkIcons() {
  const icons = path.join(ROOT, 'src-tauri', 'icons')
  const main = readPng(path.join(icons, 'icon.png'))
  assert(
    '应用主图标为 1024 方形且带 alpha',
    Boolean(main && main.w === 1024 && main.h === 1024 && main.colorType === 6),
    main ? `${main.w}x${main.h} colorType=${main.colorType}` : 'icon.png 读取失败',
  )
  const small = readPng(path.join(icons, '32x32.png'))
  assert(
    '小尺寸图标同样带 alpha（Dock/任务栏不留白底）',
    Boolean(small && small.w === 32 && small.colorType === 6),
    small ? `${small.w}x${small.h} colorType=${small.colorType}` : '32x32.png 读取失败',
  )
  for (const [name, min] of [['icon.icns', 100_000], ['icon.ico', 50_000]]) {
    const p = path.join(icons, name)
    const size = fs.existsSync(p) ? fs.statSync(p).size : 0
    assert(`存在 ${name}`, size > min, `${Math.round(size / 1024)}KB`)
  }
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error('dist/index.html 不存在，请先执行 pnpm build。')
    process.exit(2)
  }
  const chrome = firstExisting(CHROME_CANDIDATES)
  if (!chrome) {
    console.error(
      '未找到 Chrome/Chromium。请安装，或设置 CHROME_PATH=<可执行文件路径> 后重试。',
    )
    process.exit(2)
  }

  const { chromium } = loadPlaywright()
  fs.mkdirSync(OUT, { recursive: true })
  checkIcons()
  const server = await serve()
  const browser = await chromium.launch({ executablePath: chrome })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

  const errors = []
  // 带上出错时所在路由，否则「1 条页面异常」无法定位到具体页面。
  page.on('pageerror', (e) => errors.push(`${page.url().split('#')[1] ?? page.url()} → ${e.message}`))

  const go = async (hash, wait = 800) => {
    await page.goto(`http://localhost:${PORT}/${hash}`, { waitUntil: 'load' })
    await page.waitForTimeout(wait)
  }
  const shot = async (name) => {
    await page.screenshot({ path: path.join(OUT, `${name}.png`) })
  }

  // ── 1. 导航结构：不允许再出现孤立的能力分组 ─────────────
  await go('#/chat')
  const navText = await page
    .locator('.sidebar .main-nav')
    .innerText()
    .catch(() => '')
  const navItems = navText.split('\n').map((s) => s.trim()).filter(Boolean)
  // 直接断言导航文案与预期完全一致：既挡住「凭空多出一个分组」，也不需要在断言里写出被禁的旧名。
  const EXPECTED_NAV = ['插件', '项目', '专家 · 技能 · 连接器', '资料库']
  assert(
    '主导航文案与预期完全一致',
    JSON.stringify(navItems) === JSON.stringify(EXPECTED_NAV),
    JSON.stringify(navItems),
  )
  assert('主导航仅 4 项', navItems.length === 4, `count=${navItems.length}`)
  await shot('01-hero')

  // ── 2. 下拉菜单不得被触发器宽度钳死（曾把选项压成竖排） ───────────────
  const trigger = page.locator('.bar-right .app-select .trigger').first()
  if (await trigger.count()) {
    await trigger.click()
    await page.waitForTimeout(300)
    const t = await trigger.boundingBox()
    const m = await page.locator('.bar-right .app-select .menu').first().boundingBox()
    assert(
      '下拉菜单宽于触发器',
      Boolean(t && m && m.width > t.width),
      `trigger=${t ? Math.round(t.width) : '?'}px menu=${m ? Math.round(m.width) : '?'}px`,
    )
    await shot('02-hero-mode-open')
  }

  // ── 3. 首页输入框必须可输入（曾有 :disabled="!cwd" 把整块锁死） ─────────
  await go('#/chat')
  const input = page.locator('.hero-input-wrap .app-textarea').first()
  const inputDisabled = await input.isDisabled().catch(() => null)
  assert(
    '首页输入框未绑定目录时仍可输入',
    inputDisabled === false,
    `disabled=${inputDisabled}`,
  )
  // 真敲几个字：只查 disabled 属性证明不了「字进得去」。
  await input.click()
  await page.keyboard.type('冒烟测试')
  const typed = await input.inputValue().catch(() => '')
  assert('首页输入框能收到键入内容', typed.includes('冒烟测试'), `value="${typed}"`)

  // ── 4. 工作目录是**一个**控件（项目与目录合并），且模型入口在首屏 ──────
  const wsTriggers = await page.locator('.hero-input-wrap .ws-trigger').count()
  assert('首页工作目录只有一个入口', wsTriggers === 1, `count=${wsTriggers}`)
  const legacyPick = await page.locator('.bar-pick').count()
  assert('旧的独立「换目录」按钮已合并下线', legacyPick === 0, `count=${legacyPick}`)
  const wsText = (await page.locator('.hero-input-wrap .ws-trigger').first().innerText().catch(() => '')).trim()
  assert('未绑定目录时入口写着「选择工作目录」', wsText.includes('工作目录'), `text="${wsText}"`)

  // 真点开菜单：Teleport 到 body，留在 Hero 里会被 overflow 裁掉
  await page.locator('.hero-input-wrap .ws-trigger').first().click()
  await page.waitForTimeout(150)
  const menuLoc = page.locator('.ws-menu').first()
  const menuVisible = await menuLoc.isVisible().catch(() => false)
  const menuText = (await menuLoc.innerText().catch(() => '')).trim()
  assert('目录菜单能真的展开', menuVisible, `visible=${menuVisible}`)
  assert(
    '菜单里既有项目列表也有「选择本地目录…」',
    menuText.includes('选择本地目录'),
    `text="${menuText.replace(/\s+/g, ' ').slice(0, 60)}"`,
  )
  // 只看 isVisible 会漏：它不检查是否在屏内。Teleport + fixed 定位一旦没算坐标，
  // 菜单会落在页面末尾（y = 视口高），断言全绿而用户什么都看不到。
  const menuBox = await menuLoc.boundingBox()
  const trigBox = await page.locator('.hero-input-wrap .ws-trigger').first().boundingBox()
  const vp = page.viewportSize() ?? { width: 1440, height: 900 }
  assert(
    '目录菜单位于视口内（不是甩到页面末尾）',
    Boolean(
      menuBox &&
        menuBox.y >= 0 &&
        menuBox.y + menuBox.height <= vp.height + 1 &&
        menuBox.x >= 0 &&
        menuBox.x + menuBox.width <= vp.width + 1,
    ),
    menuBox
      ? `menu=(${Math.round(menuBox.x)},${Math.round(menuBox.y)}) ${Math.round(menuBox.width)}x${Math.round(menuBox.height)} vp=${vp.width}x${vp.height}`
      : 'no box',
  )
  assert(
    '目录菜单水平对齐触发器',
    Boolean(menuBox && trigBox && Math.abs(menuBox.x - trigBox.x) <= 48),
    menuBox && trigBox
      ? `menu.x=${Math.round(menuBox.x)} trigger.x=${Math.round(trigBox.x)}`
      : 'no box',
  )
  await shot('01d-hero-workspace-menu')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(120)
  const menuClosed = await page.locator('.ws-menu').count()
  assert('Escape 能收起目录菜单', menuClosed === 0, `count=${menuClosed}`)
  const hasModel = await page.locator('.model-switcher').first().count()
  assert('首页有模型选择器', hasModel > 0, `count=${hasModel}`)
  // 模型名旁边重复打印 provider·model 是纯噪音，已移除
  const dupHint = await page.locator('.ms-hint').count()
  assert('模型名后不再重复显示 provider', dupHint === 0, `count=${dupHint}`)
  // 附件按钮只有提示态、没有实际能力，已移除
  const attachBtn = await page.locator('.hero-input-wrap .bar-btn').count()
  assert('首页不再有无功能的附件按钮', attachBtn === 0, `count=${attachBtn}`)

  // ── 4b. 首页品牌图：透明底高清原图，且只有一处 ──────────────────────
  const brand = await page.evaluate(async () => {
    const img = document.querySelector('.hero-mascot')
    if (!img) return null
    try {
      await img.decode()
    } catch {
      /* 解码失败由下面的尺寸断言兜住 */
    }
    return { src: img.getAttribute('src'), w: img.naturalWidth, h: img.naturalHeight }
  })
  // 阈值取「显示尺寸 136px 的 2 倍」：低于这个数在高分屏上就是糊的。
  assert(
    '首页品牌图为高清原图（≥2x 显示尺寸）',
    Boolean(brand && Math.max(brand.w, brand.h) >= 272),
    brand ? `src=${brand.src} natural=${brand.w}x${brand.h}` : '未找到 .hero-mascot',
  )
  assert(
    '品牌图只有一处且旧小图已下线',
    (await page.locator('.hero-mark').count()) === 0 &&
      (await page.locator('.hero-mascot').count()) === 1,
    '',
  )
  // 透明底：直接读原图左上角像素的 alpha，而不是靠肉眼判断「有没有白底方块」。
  const cornerAlpha = await page
    .evaluate(async (src) => {
      const blob = await (await fetch(src)).blob()
      const bmp = await createImageBitmap(blob)
      const c = document.createElement('canvas')
      c.width = bmp.width
      c.height = bmp.height
      const ctx = c.getContext('2d')
      ctx.drawImage(bmp, 0, 0)
      return ctx.getImageData(0, 0, 1, 1).data[3]
    }, brand?.src ?? '/mascot.png')
    .catch(() => -1)
  assert('品牌图为透明底（四角无底色块）', cornerAlpha === 0, `corner alpha=${cornerAlpha}`)

  // ── 4c. 首页只允许一套强调色（曾用绿/橙/蓝三色分类，与全局主色打架） ──
  const pillBg = await page
    .locator('.cat-pill.on')
    .first()
    .evaluate((el) => getComputedStyle(el).backgroundColor)
    .catch(() => '')
  assert(
    '分类选中态跟随全局强调色',
    pillBg === 'rgb(37, 99, 235)' || pillBg === 'rgb(79, 140, 255)',
    `bg=${pillBg}`,
  )

  // ── 5. 侧栏底部是实时用量卡，且不得出现写死的演示额度 ────────────────
  const sidebarText = await page.locator('.sidebar').innerText().catch(() => '')
  assert('侧栏存在实时用量卡', (await page.locator('.usage-card').count()) > 0, '')
  assert(
    '侧栏不再展示写死的演示余额',
    !sidebarText.includes('96.28') && !sidebarText.includes('演示'),
    `placeholder-present=${sidebarText.includes('演示')}`,
  )
  assert(
    '用量卡无数据时如实说明',
    sidebarText.includes('还没有用量数据') || sidebarText.includes('需在桌面 App 内查看'),
    '',
  )
  await shot('01b-hero-input')

  // ── 5b. 深色主题下首页背景随之切换（品牌图是透明底，不该露出白色方块） ──
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'))
  await page.waitForTimeout(250)
  await shot('01c-hero-dark')
  const darkBg = await page
    .locator('.chat-hero')
    .evaluate((el) => getComputedStyle(el).backgroundImage)
    .catch(() => '')
  assert('深色主题下首页背景随之切换', darkBg.includes('rgb(18, 26, 34)'), darkBg.slice(0, 64))
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  await page.waitForTimeout(150)

  // ── 6. 全局 CSS 污染回归守卫 ────────────────────────────────────────
  // 能力中心与资料库的 .tool-btn 是带文字的普通按钮；agent-ops.css 曾把它压成 30×30。
  await go('#/capabilities')
  const capBtn = await page.locator('.market-tools .tool-btn').first().boundingBox()
  assert(
    '能力中心按钮未被压成图标方块',
    Boolean(capBtn && capBtn.width > 40),
    `width=${capBtn ? Math.round(capBtn.width) : 'n/a'}px`,
  )

  // ── 7. 运行层视图内图标按钮仍是 30×30（作用域限定后未被误伤） ────────
  await go('#/capabilities?tab=team')
  const octoBtn = await page.locator('.agent-ops .tool-btn').first().boundingBox()
  if (octoBtn) {
    assert('运行层图标按钮保持 30px', Math.round(octoBtn.width) === 30, `width=${Math.round(octoBtn.width)}px`)
  }
  await shot('03-capabilities-team')

  // ── 8. 逐路由截图（结构巡检，不做几何断言） ─────────────────────────
  const routes = [
    ['04-capabilities-skill', '#/capabilities?tab=skill'],
    ['05-capabilities-market', '#/capabilities?tab=market'],
    ['06-capabilities-browser', '#/capabilities?tab=browser'],
    ['07-capabilities-connector', '#/capabilities?tab=connector'],
    ['08-library', '#/library'],
    ['09-library-memory', '#/library?view=memory'],
    ['10-projects', '#/projects'],
    ['11-settings', '#/settings'],
  ]
  for (const [name, hash] of routes) {
    await go(hash)
    await shot(name)
  }

  // ── 9. 全流程：目录 / 项目切换必须真的走得通 ────────────────────────
  // 浏览器预览里 Tauri IPC 不存在，项目列表永远为空 —— 「点了没反应」这类缺陷
  // 正是这样从前面所有断言底下溜过去的。这里注入一份复刻桌面端的 store：
  // 一个没绑目录的项目（模板建的） + 一个已绑目录的项目。
  const flowErrors = []
  const page2 = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page2.on('pageerror', (e) => flowErrors.push(e.message))
  // Vue 把渲染期异常吞进 console.error，只看 pageerror 会漏掉整类崩溃。
  page2.on('console', (m) => {
    if (m.type() === 'error') flowErrors.push(m.text())
  })
  await page2.addInitScript(`
(() => {
  let cbId = 0
  const projects = [
    { id: 'p-flow-a', name: '产品需求全流程', path: null, archived: false, updated_at: 2 },
    { id: 'p-flow-b', name: 'pi-workbench', path: '/Users/tatsuma/Documents/GIT/pi-workbench', archived: false, updated_at: 1 },
  ]
  window.__PI_STUB__ = { calls: [], bound: null }
  // 事件插件退订时要回调这个内部对象；不打桩会在「离开对话页」时抛
  // unregisterListener of undefined —— 又是空桩自己造出来的假崩溃。
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {}, registerListener() {} }
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
      if (cmd === 'project_get') {
        const p = projects.find((x) => x.id === args.id) || projects[0]
        return r({
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
          work_items: [],
          assets: [],
          tasks: [],
          activity: [],
          instruction_usage: { tokens: 120, budget: 4000 },
        })
      }
      if (cmd === 'plugin:dialog|open') return r('/tmp/flow-demo-repo')
      // 这几个命令在真实后端返回数组/对象；打桩必须给同样的形状，
      // 否则空桩自己会造出 null.length，把真缺陷淹掉。
      if (cmd === 'role_list') return r([])
      if (cmd === 'role_current') return r({ id: 'general', name: '通用', description: '', prompt: '' })
      if (cmd === 'fs_read_dir') return r([])
      if (cmd === 'fs_read_file') return r('')
      if (cmd === 'settings_load') return r({ models: [] })
      // 内核自检：桌面进程 PATH 里常没有 pi，设置页要显示探测结果。
      if (cmd === 'pi_doctor') return r({ found: true, path: '/opt/homebrew/bin/pi', probed: 12, error: null })
      // 发消息：failSend 打开时模拟「内核未启动」，用来验证失败不是静默的。
      if (cmd === 'pi_send') {
        return window.__PI_STUB__.failSend ? Promise.reject('pi 未启动') : r(null)
      }
      if (cmd === 'projects_templates') return r([])
      if (typeof cmd === 'string' && (cmd.startsWith('plugin:event|') || cmd.includes('|listen'))) return r(0)
      // ── 已有功能「真跑通」验证：返回真实形状的清单数据，证明 UI 接到的是真结构而非空壳 ──
      if (cmd === 'extensions_list') return r([
        { id: 'agent-codebase.ts', name: '代码库索引', description: '用 codebase-memory-mcp 为项目建图并支持对话检索', kind: 'tool', path: '/cfg/extensions/agent-codebase.ts', tools: ['codebase_search', 'codebase_architecture', 'codebase_query', 'codebase_status'], enabled: true },
        { id: 'agent-memory.ts', name: '长期记忆', description: '把对话要点追加进 .pi/memory 的 ts/text 流', kind: 'tool', path: '/cfg/extensions/agent-memory.ts', tools: ['memory_store', 'memory_recall'], enabled: true },
        { id: 'agent-browser-session.ts', name: '浏览器会话', description: '开真实浏览器并维护会话状态', kind: 'tool', path: '/cfg/extensions/agent-browser-session.ts', tools: ['browser_open', 'browser_fetch', 'browser_screenshot'], enabled: false },
      ])
      if (cmd === 'library_list') return r([
        { id: 'a1', name: '会议纪要.md', rel_path: '/docs/会议纪要.md', kind: 'markdown', dir: '/docs', origin: { kind: 'local' }, enabled: true, searchable: true, draft: false, revision: 2, size: 2048, updated_at: Date.now() },
        { id: 'a2', name: '需求.doc', rel_path: '/docs/需求.doc', kind: 'docx', dir: '/docs', origin: { kind: 'import' }, enabled: true, searchable: true, draft: false, revision: 1, size: 4096, updated_at: Date.now() },
      ])
      if (cmd === 'library_stats') return r({ asset_count: 2, used_bytes: 6144, max_total_bytes: 104857600 })
      if (cmd === 'library_tree') return r([ { path: '/', name: '', is_dir: true, asset_id: null }, { path: '/docs', name: 'docs', is_dir: true, asset_id: null }, { path: '/docs/会议纪要.md', name: '会议纪要.md', is_dir: false, asset_id: 'a1' } ])
      if (cmd === 'library_marks') return r([ { id: 'a1', name: '会议纪要.md', dir: '/docs' } ])
      if (cmd === 'library_search') return r([ { asset_id: 'a1', name: '会议纪要.md', dir: '/docs', kind: 'markdown', origin: { kind: 'local' }, revision: 2, location: '摘要', snippet: '本次会议决定了…', convert_status: 'ready' } ])
      if (cmd === 'skills_list') return r([ { name: 'pdf', description: 'PDF 读写与转换', kind: 'skill', path: '/skills/pdf', via: 'local', scope: 'user', origin: 'local' }, { name: 'docx', description: 'Word 文档处理', kind: 'skill', path: '/skills/docx', via: 'local', scope: 'user', origin: 'local' } ])
      if (cmd === 'experts_list') return r([ { id: 'e1', name: '代码审查专家', description: '审查 diff 并给出风险', role_id: 'reviewer' } ])
      if (cmd === 'project_index_status') return r({ indexed: true, nodes: 3130, edges: 8836, project_name: 'Users-tatsuma-Documents-GIT-pi-workbench', error: null, indexing: false })
      if (cmd === 'conversations_list' || cmd === 'conversation_list') return r([ { id: 'c1', title: '产品需求补全', updated_at: Date.now() } ])
      return r(null)
    },
  }
})()
`)
  await page2.goto(`http://localhost:${PORT}/#/chat`, { waitUntil: 'load' })
  await page2.waitForTimeout(700)

  /** 落地页与会话流各有一个工作目录入口：取当前真正在的那个。 */
  const pickerLabel = async (p) => {
    const heroPicker = p.locator('.hero-input-wrap .ws-trigger').first()
    if (await heroPicker.count()) return (await heroPicker.innerText().catch(() => '')).trim()
    return (await p.locator('.chat-header .ws-trigger').first().innerText().catch(() => '')).trim()
  }

  const flowInput = page2.locator('.hero-input-wrap .app-textarea').first()
  const wrapBefore = await page2
    .locator('.hero-input-wrap')
    .evaluate((el) => getComputedStyle(el).borderBottomColor)
    .catch(() => '')
  await flowInput.click()
  await page2.waitForTimeout(200)
  // 「点一下输入框中间冒出个细框」= AppTextarea 自带 focus 环没被上层规则压掉。
  const taShadow = await flowInput.evaluate((el) => getComputedStyle(el).boxShadow).catch(() => '')
  const wrapAfter = await page2
    .locator('.hero-input-wrap')
    .evaluate((el) => getComputedStyle(el).borderBottomColor)
    .catch(() => '')
  assert('输入框聚焦后不再套一层细框（textarea 自身 focus 环已压掉）', taShadow === 'none', `boxShadow=${taShadow}`)
  assert(
    '输入框聚焦反馈仍在（外层容器边框变色）',
    wrapBefore !== '' && wrapAfter !== wrapBefore,
    `${wrapBefore} → ${wrapAfter}`,
  )

  await page2.locator('.hero-input-wrap .ws-trigger').first().click()
  await page2.waitForTimeout(250)
  const flowMenu = page2.locator('.ws-menu').first()
  const flowMenuText = (await flowMenu.innerText().catch(() => '')).replace(/\s+/g, ' ')
  assert('全流程：目录菜单能展开', await flowMenu.isVisible().catch(() => false), `visible`)
  assert(
    '全流程：没绑目录的项目在菜单里列出并说明缺什么',
    flowMenuText.includes('产品需求全流程') && flowMenuText.includes('未绑定目录'),
    flowMenuText.slice(0, 72),
  )
  await page2.screenshot({ path: path.join(OUT, '30-flow-menu.png') })

  // 点没绑目录的项目：必须就地拉起目录选择器并落库，而不是静默什么都不发生
  const flowOpt = page2
    .locator('.ws-menu .ws-opt')
    .filter({ hasText: '产品需求全流程' })
    .first()
  await flowOpt.click()
  await page2.waitForTimeout(600)
  const bound = await page2.evaluate(() => window.__PI_STUB__.bound)
  const flowCalls = await page2.evaluate(() => window.__PI_STUB__.calls)
  assert(
    '全流程：点没绑目录的项目会拉起目录选择器并绑定目录',
    Boolean(bound && bound.id === 'p-flow-a' && bound.path === '/tmp/flow-demo-repo'),
    JSON.stringify(bound),
  )
  assert(
    '全流程：绑定后项目被激活（不再只是「点了没反应」）',
    flowCalls.includes('project_set_active'),
    flowCalls.slice(-6).join(','),
  )
  // 选完项目必须**仍然停在落地页**（用户原话：「选择了项目应该还停留在原来的界面」）。
  // 老版式在这里就把落地页撤掉、换成左右两侧的工作台栏，中间只剩一条空对话。
  const heroAfterBind = await page2.locator('.chat-hero').count()
  const heroLabelAfterBind = (
    await page2.locator('.hero-input-wrap .ws-trigger').first().innerText().catch(() => '')
  ).trim()
  assert('全流程：绑定目录后仍停在落地页', heroAfterBind === 1, `hero=${heroAfterBind}`)
  assert(
    '全流程：落地页的工作目录入口显示刚绑定的项目',
    heroLabelAfterBind.includes('产品需求全流程'),
    `label="${heroLabelAfterBind}"`,
  )
  const colsOnHero = await page2.locator('.chat > .left, .chat > .right').count()
  assert('全流程：落地页两侧不再有文件树 / 终端 / 浏览器侧栏', colsOnHero === 0, `count=${colsOnHero}`)
  await page2.screenshot({ path: path.join(OUT, '31-flow-bound.png') })

  // 侧栏切项目：/chat 已挂载（router.push 不会重新挂载），必须靠共享状态跟着换
  await page2.locator('.sidebar .ws-list li').filter({ hasText: 'pi-workbench' }).first().click()
  await page2.waitForTimeout(700)
  const labelAfterSidebar = (await pickerLabel(page2)).trim()
  assert(
    '全流程：侧栏切项目后对话页跟着换工作目录',
    labelAfterSidebar.includes('pi-workbench'),
    `label="${labelAfterSidebar}"`,
  )
  await page2.screenshot({ path: path.join(OUT, '32-flow-sidebar-switch.png') })

  // 发出第一条消息 —— 到这里才切到会话流（消息 + 输入框 + 按需展开的过程抽屉）
  const heroInput = page2.locator('.hero-input-wrap .app-textarea').first()
  await heroInput.click()
  await page2.keyboard.type('把项目说明补全')
  await page2.locator('.hero-send').click()
  await page2.waitForTimeout(700)
  assert(
    '全流程：发出第一条消息后离开落地页',
    (await page2.locator('.chat-hero').count()) === 0,
    `hero=${await page2.locator('.chat-hero').count()}`,
  )
  const chatHeaderLabel = (
    await page2.locator('.chat-header .ws-trigger').first().innerText().catch(() => '')
  ).trim()
  assert(
    '全流程：会话流头部显示当前项目',
    chatHeaderLabel.includes('pi-workbench'),
    `label="${chatHeaderLabel}"`,
  )
  const ioBtns = await page2.locator('.io-group .io-btn').count()
  assert('会话迁移：导出/导入按钮就位', ioBtns === 2, `btns=${ioBtns}`)

  // 发出去了就得看得见「在跑」：回答首字到达前必须有一个机器人侧的等待气泡，
  // agent 步骤条也要直接在对话区可见，而不是藏进默认收起的抽屉里。
  const waitingBubble = await page2.locator('.msg-row.waiting').count()
  assert(
    '等待模型响应：回答首字到达前有机器人占位气泡',
    waitingBubble === 1,
    `count=${waitingBubble}`,
  )
  const stepStrip = await page2.locator('.step-strip').count()
  assert(
    'agent 轨迹：步骤条在对话区直接可见（不必先点开抽屉）',
    stepStrip === 1,
    `count=${stepStrip}`,
  )

  // 头部必须单行：pill 高度就是一行控件的高度（≤ 44px），不能折成两行。
  const headerBox = await page2.locator('.chat-header').first().boundingBox()
  const pillBox = await page2.locator('.header-pill').first().boundingBox()
  assert(
    '头部：上下文 pill 不折行',
    !!pillBox && pillBox.height <= 44,
    `pill height=${pillBox?.height}`,
  )
  assert(
    '头部：整个 header 保持单行高度',
    !!headerBox && headerBox.height <= 64,
    `header height=${headerBox?.height}`,
  )

  // 底部状态不再用浮在输入框上方的大卡片，而是收进 composer 里的一条细 status 行。
  assert(
    '底部：旧的 activity-dock 大卡片已下线',
    (await page2.locator('.activity-dock').count()) === 0,
    `count=${await page2.locator('.activity-dock').count()}`,
  )
  assert(
    '底部：composer 内置状态行存在',
    (await page2.locator('.composer-status').count()) === 1,
    `count=${await page2.locator('.composer-status').count()}`,
  )

  // 内核不可用时必须**看得见**：失败要落进消息流，不能只在顶部飘一条 6 秒提示。
  // 用户原话「回车或者点击发送的时候没任何反应」——静默失败正是这个 bug 的形状。
  await page2.evaluate(() => {
    window.__PI_STUB__.failSend = true
  })
  const failInput = page2.locator('.composer .app-textarea').first()
  await failInput.click()
  await page2.keyboard.type('内核挂了会怎样')
  // 用回车而不是点按钮：上一轮流式没有结束事件，发送按钮此刻是禁用态。
  await page2.keyboard.press('Enter')
  await page2.waitForTimeout(600)
  const msgsText = (await page2.locator('.msgs').innerText().catch(() => '')).replace(/\s+/g, ' ')
  assert(
    '内核不可用：错误落进消息流（不再「点了没反应」）',
    msgsText.includes('内核未响应'),
    msgsText.slice(-110),
  )
  await page2.screenshot({ path: path.join(OUT, '36-kernel-unavailable.png') })
  await page2.evaluate(() => {
    window.__PI_STUB__.failSend = false
  })

  const colsAfterSend = await page2.locator('.chat > .left, .chat > .right').count()
  assert('全流程：会话流里也没有常驻工作台侧栏', colsAfterSend === 0, `count=${colsAfterSend}`)

  const drawerBefore = await page2.locator('.trace-drawer.open').count()
  await page2.locator('.trace-toggle').first().click()
  await page2.waitForTimeout(320)
  const drawerAfter = await page2.locator('.trace-drawer.open').count()
  const drawerTabs = await page2.locator('.trace-drawer .td-tab').allInnerTexts()
  assert(
    '全流程：过程抽屉默认收起、点击展开',
    drawerBefore === 0 && drawerAfter === 1,
    `${drawerBefore} → ${drawerAfter}`,
  )
  assert(
    '全流程：抽屉里有会话树 / 轨迹 / 工作流 / 连接器',
    ['会话树', '轨迹', '工作流', '连接器'].every((l) =>
      drawerTabs.some((t) => t.replace(/\s+/g, '').startsWith(l)),
    ),
    drawerTabs.map((t) => t.replace(/\s+/g, '')).join('/'),
  )
  await page2.screenshot({ path: path.join(OUT, '33-flow-chat-trace.png') })

  // 过程面板之外的工具（文件 / 终端 / 浏览器）归项目详情页。
  // 从侧栏项目行的「工作台」入口过去 —— 这条入口本身也是这版新加的。
  await page2
    .locator('.sidebar .ws-list li')
    .filter({ hasText: 'pi-workbench' })
    .locator('.ws-open')
    .first()
    .click()
  await page2.waitForTimeout(700)
  assert(
    '全流程：侧栏项目行的工作台入口能进项目详情页',
    page2.url().includes('/projects/'),
    page2.url(),
  )
  const pwTabs = (await page2.locator('.pw-tab').allInnerTexts()).map((t) => t.trim())
  assert(
    '项目详情页：文件 / 终端 / 浏览器三个工具面都在',
    ['文件', '终端', '浏览器'].every((l) => pwTabs.includes(l)),
    pwTabs.join('/'),
  )
  await page2.locator('.pw-tab').filter({ hasText: '文件' }).first().click()
  await page2.waitForTimeout(350)
  assert(
    '项目详情页：文件面渲染出文件树 + 编辑面板',
    (await page2.locator('.fws-tree').count()) === 1 && (await page2.locator('.fedit').count()) === 1,
    '',
  )
  await page2.screenshot({ path: path.join(OUT, '34-project-files.png') })
  await page2.locator('.pw-tab').filter({ hasText: '终端' }).first().click()
  await page2.waitForTimeout(350)
  assert('项目详情页：终端面渲染', (await page2.locator('.pw-body .term').count()) === 1, '')
  await page2.locator('.pw-tab').filter({ hasText: '浏览器' }).first().click()
  await page2.waitForTimeout(350)
  assert('项目详情页：浏览器面渲染', (await page2.locator('.pw-body .agent-browser').count()) === 1, '')
  await page2.screenshot({ path: path.join(OUT, '35-project-browser.png') })

  // 从项目页回对话页：ChatView 会重新挂载，但共享的活动项目**没变**
  // （ref 不变 → watcher 不触发），工作目录必须靠自己补同步。
  await page2.locator('.pw-open-chat').click()
  await page2.waitForTimeout(700)
  const labelAfterRemount = (await pickerLabel(page2)).trim()
  assert(
    '全流程：从项目页返回对话页后工作目录仍然保持',
    labelAfterRemount.includes('pi-workbench'),
    `label="${labelAfterRemount}"`,
  )

  // 「新会话」必须真的回到落地页：消息与流式状态都在 ChatView 实例里，
  // 同路由 push 不会重挂载 —— 换了 key 之后才清得掉。
  await page2.locator('.hero-input-wrap .app-textarea').first().click()
  await page2.keyboard.type('再来一轮')
  await page2.locator('.hero-send').click()
  await page2.waitForTimeout(650)
  const beforeNewChat = await page2.locator('.chat-hero').count()
  await page2.locator('.sidebar .new-chat').click()
  await page2.waitForTimeout(650)
  const afterNewChat = await page2.locator('.chat-hero').count()
  assert(
    '全流程：「新会话」回到落地页',
    beforeNewChat === 0 && afterNewChat === 1,
    `${beforeNewChat} → ${afterNewChat}`,
  )

  // ── 9b. 已有功能「真渲染」验证：证明 UI 接到的是真实 IPC 形状而非空壳 ──
  // 这一步直接回应「是不是只加了壳子没干活」——桩返回真实清单，断言视图真的渲染出内容。
  await page2.goto(`http://localhost:${PORT}/#/plugins`, { waitUntil: 'load' })
  await page2.waitForTimeout(600)
  const pluginRows = await page2.locator('.market-row').count()
  assert('插件市场：渲染出真实扩展行（非空壳）', pluginRows >= 3, `rows=${pluginRows}`)
  const enabledFlags = await page2.locator('.market-row .row-flag').count()
  assert('插件市场：显示已载入/未载入状态', enabledFlags >= 1, `flags=${enabledFlags}`)
  await page2.screenshot({ path: path.join(OUT, '36-plugins-real.png') })

  await page2.goto(`http://localhost:${PORT}/#/library`, { waitUntil: 'load' })
  await page2.waitForTimeout(600)
  const libNodes = await page2.locator('.tree-node').count()
  assert('资料库：目录树渲染出节点（非空壳）', libNodes >= 2, `nodes=${libNodes}`)
  const libQuota = await page2.locator('.lib-quota').count()
  assert('资料库：配额卡渲染', libQuota === 1, `quota=${libQuota}`)
  await page2.screenshot({ path: path.join(OUT, '37-library-real.png') })

  await page2.goto(`http://localhost:${PORT}/#/capabilities?tab=skill`, { waitUntil: 'load' })
  await page2.waitForTimeout(500)
  const skillCards = await page2.locator('.market-card').count()
  assert('能力中心：技能列表渲染', skillCards >= 1, `cards=${skillCards}`)
  await page2.screenshot({ path: path.join(OUT, '38-capabilities-real.png') })

  const fatal = flowErrors.filter((t) => /Cannot read properties|is not a function|undefined is not/.test(t))
  assert('全流程：无渲染期崩溃', fatal.length === 0, fatal.slice(0, 2).join(' | ').slice(0, 120))
  await page2.close()

  // 浏览器预览下 Tauri IPC 缺失属预期；只提示，不作为失败项。
  if (errors.length) {
    console.log(`\n提示：捕获 ${errors.length} 条页面异常（浏览器预览无 Tauri IPC 时属预期）`)
    for (const line of errors.slice(0, 5)) console.log('  ' + line)
  }

  await browser.close()
  server.close()

  const failed = results.filter((r) => !r.ok)
  console.log(`\n截图输出：${OUT}`)
  console.log(`断言：${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length ? 1 : 0)
}

main().catch((e) => {
  console.error('visual-check 失败：', e)
  process.exit(1)
})
