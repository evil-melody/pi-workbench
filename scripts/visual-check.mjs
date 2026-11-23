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
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')
const OUT = path.join(ROOT, '.visual-check')
const PORT = Number(process.env.VISUAL_CHECK_PORT ?? 4321)

// 起服务 / 找 Chrome / 载 playwright 与 simulate-run-chain.mjs 共用一份实现。
const { findChrome, loadPlaywright, serveDist, inspectRunGraph } = await import('./lib/preview.mjs')
const { PI_STUB_SCRIPT: STUB_SCRIPT } = await import('./lib/pi-stub.mjs')

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

/**
 * 令牌漂移门禁：--r-md / --font-mono 从未定义，却曾在 4+11 处被引用；
 * 前者圆角塌成直角，后者丢失中文字体回退。此处静态锁死，避免回潮。
 */
function checkTokenDrift() {
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
    )
  const bad = []
  for (const file of walk(path.join(ROOT, 'src')).filter((f) => f.endsWith('.css'))) {
    const css = fs.readFileSync(file, 'utf8')
    const name = path.relative(ROOT, file)
    if (/var\(--r-md/.test(css)) bad.push(`${name}: r-md`)
    if (/var\(--font-mono/.test(css)) bad.push(`${name}: font-mono`)
    if (/font-family:\s*ui-monospace/.test(css)) bad.push(`${name}: mono stack`)
  }
  assert('精细化：无未定义圆角/等宽令牌漂移', bad.length === 0, bad.slice(0, 3).join(', '))
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error('dist/index.html 不存在，请先执行 pnpm build。')
    process.exit(2)
  }
  const chrome = findChrome()
  if (!chrome) {
    console.error(
      '未找到 Chrome/Chromium。请安装，或设置 CHROME_PATH=<可执行文件路径> 后重试。',
    )
    process.exit(2)
  }

  const { chromium } = loadPlaywright()
  fs.mkdirSync(OUT, { recursive: true })
  checkIcons()
  checkTokenDrift()
  const server = (await serveDist(DIST, PORT)).server
  // --disable-gpu：这套脚本在同一台机器连跑时，GPU 进程会偶发崩溃，表现为
  // 任意一步抛 “Target page ... has been closed”。关掉 GPU 走软件渲染后 123/123 稳定。
  const browser = await chromium.launch({ executablePath: chrome, args: ['--disable-gpu'] })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

  const errors = []
  // 带上出错时所在路由，否则「1 条页面异常」无法定位到具体页面。
  page.on('pageerror', (e) => errors.push(`${page.url().split('#')[1] ?? page.url()} → ${e.message}`))

  const go = async (hash, wait = 800) => {
    await page.goto(`http://localhost:${PORT}/${hash}`, { waitUntil: 'load' })
    await page.waitForTimeout(wait)
  }
  const shot = async (name) => {
    // animations:'disabled'：降级态骨架屏的 spinner 是无限动画，会把截图一直拖到超时
    // （实测卡在 04-capabilities-skill，日志停在 fonts loaded 之后）。冻结动画到结束态再拍。
    await page.screenshot({ path: path.join(OUT, `${name}.png`), animations: 'disabled' })
  }

  // ── 1. 导航结构：不允许再出现孤立的能力分组 ─────────────
  await go('#/chat')
  // 双层侧栏：导航进窄轨道，只剩图标 + title（tooltip），文案改从 title 取。
  const navTitles = await page.locator('.sidebar .rail-item').evaluateAll((els) =>
    els.map((e) => e.getAttribute('title') ?? ''),
  )
  const EXPECTED_NAV = ['对话', '收件箱', '插件', '本地模型', '专家 · 技能 · 连接器', '资料库']
  assert(
    '主导航文案与预期完全一致',
    JSON.stringify(navTitles) === JSON.stringify(EXPECTED_NAV),
    JSON.stringify(navTitles),
  )
  assert('主导航仅 6 项（「项目」已收进工作区列表）', navTitles.length === 6, `count=${navTitles.length}`)
  assert('#80：双层侧栏——图标轨道与会话面板同时在', (await page.locator('.sidebar .rail').count()) === 1 && (await page.locator('.sidebar .side-panel').count()) === 1, `rail=${await page.locator('.rail').count()} panel=${await page.locator('.side-panel').count()}`)
  assert('#80：面板含新会话入口与项目列表', (await page.locator('.side-panel .ws-new').count()) === 1 && (await page.locator('.side-panel .ws-list').count()) === 1, '')

  // 精细化：长文本收口。侧栏品牌名曾注入长文本溢出 1013px（nowrap 无 ellipsis）。
  // 注入后立刻还原，避免污染后续导航/截图断言。
  const bnameClip = await page.evaluate(() => {
    const el = document.querySelector('.panel-title')
    if (!el) return null
    const old = el.textContent
    el.textContent = '超长文本压力测试'.repeat(12)
    // text-overflow:ellipsis 只改渲染不裁 scrollWidth，故只断言样式生效。
    const ok = getComputedStyle(el).textOverflow === 'ellipsis'
    el.textContent = old
    return ok
  })
  assert('精细化：侧栏品牌名超长文本有 ellipsis 收口', bnameClip === true, String(bnameClip))
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
  const pillShadow = await page
    .locator('.cat-pill.on')
    .first()
    .evaluate((el) => getComputedStyle(el).boxShadow)
    .catch(() => '')
  // 落地页唯一主色按钮是发送键；分类只是筛选器，选中态用浅底 + 1px 内描边。
  assert(
    '分类选中态用浅底+内描边（主色只留给发送键）',
    !['rgb(37, 99, 235)', 'rgb(79, 140, 255)'].includes(pillBg) && pillShadow.includes('inset'),
    `bg=${pillBg} shadow=${pillShadow}`,
  )

  // ── 4d. 图标语义：借用「提交上箭头」当邮件/模式/调度图标是语义错误 ──
  // AppIcon 输出 data-icon，断言直接锁名字，比锁 path 抗改版。
  const chipIcon = (label) =>
    page
      .locator('.skill-chip')
      .filter({ hasText: label })
      .first()
      .locator('.app-icon')
      .first()
      .getAttribute('data-icon')
      .catch(() => '')
  assert('「邮件撰写」用邮件图标（不是提交箭头）', (await chipIcon('邮件撰写')) === 'mail')
  assert('「会议纪要」用气泡图标', (await chipIcon('会议纪要')) === 'chat')
  assert('「数据分析」用折线图标', (await chipIcon('数据分析')) === 'chart')

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
  // 批 1 F8 把首页的装饰渐变撤了（底色收敛为纯 --bg），守卫随之改量 backgroundColor：
  // 要守的还是同一件事——切到深色时首页整体变暗，透明品牌图不露白底方块。
  const darkBg = await page
    .locator('.chat-hero')
    .evaluate((el) => getComputedStyle(el).backgroundColor)
    .catch(() => '')
  const [darkR, darkG, darkB] = darkBg.match(/\d+/g)?.map(Number) ?? [255, 255, 255]
  assert('深色主题下首页背景随之切换', darkR + darkG + darkB < 200, darkBg.slice(0, 64))
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'))
  await page.waitForTimeout(150)

  // ── 6. 全局 CSS 污染回归守卫 ────────────────────────────────────────
  // 能力中心与资料库的工具条按钮是带文字的 AppButton；agent-ops.css 曾把同类按钮压成 30×30。
  await go('#/capabilities')
  const capBtn = await page.locator('.market-tools .app-btn').first().boundingBox()
  assert(
    '能力中心按钮未被压成图标方块',
    Boolean(capBtn && capBtn.width > 40),
    `width=${capBtn ? Math.round(capBtn.width) : 'n/a'}px`,
  )
  // 侧栏入口叫「专家 · 技能 · 连接器」，无 query 进来必须落专家页；
  // 落技能页等于进门走错房间（WorkBuddy 亦默认专家）。
  const defaultTab = await page.locator('.market-tab.active').first().innerText().catch(() => '')
  assert('能力中心默认页是「专家」', defaultTab.includes('专家'), defaultTab)

  // ── 7. 运行层视图内图标按钮仍是 28×28（作用域限定后未被误伤） ────────
  await go('#/capabilities?tab=team')
  const octoBtn = await page.locator('.agent-ops .tool-btn').first().boundingBox()
  if (octoBtn) {
    assert('运行层图标按钮保持 28px', Math.round(octoBtn.width) === 28, `width=${Math.round(octoBtn.width)}px`)
  }
  // 专家团关卡（LoopForge human-gate）：团队卡要有关卡/覆盖徽章，
  // 运行记录里要有待审关卡与放行/驳回入口。
  // 主巡检页没装桩（它测的是无 IPC 时的降级形态），徽章断言要有真数据，
  // 所以单开一个装了桩的页面——看不见数据的断言测的只是空态。
  const pageTeam = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await pageTeam.addInitScript(STUB_SCRIPT)
  await pageTeam.goto(`http://localhost:${PORT}/#/capabilities?tab=team`, { waitUntil: 'load' })
  await pageTeam.waitForTimeout(700)
  const teamCard = pageTeam.locator('.team-card').first()
  const teamText = (await teamCard.innerText().catch(() => '')).replace(/\s+/g, ' ')
  assert(
    '专家团：团队卡显示关卡与执行器覆盖徽章',
    teamText.includes('关卡') && teamText.includes('覆盖'),
    teamText.slice(0, 160),
  )
  await teamCard.locator('.team-runs').first().click()
  await pageTeam.waitForTimeout(500)
  const gateBox = pageTeam.locator('.gate-box')
  const gateText = (await gateBox.innerText().catch(() => '')).replace(/\s+/g, ' ')
  assert(
    '专家团：运行记录显示待放行关卡（放行/驳回）',
    (await gateBox.count()) === 1 && gateText.includes('等待放行') && gateText.includes('放行') && gateText.includes('驳回'),
    gateText.slice(0, 120),
  )
  // 成本汇总：运行卡头部显示本次运行 token 合计（成员 4200 + 1800 = 6000）。
  const tokenText = (await pageTeam.locator('.run-tokens').first().innerText().catch(() => ''))
  assert(
    '专家团：运行卡显示 token 消耗合计',
    tokenText.includes('6') && tokenText.toLowerCase().includes('token'),
    tokenText,
  )
  const rowTokens = await pageTeam.locator('.run-row-tokens').count()
  assert('专家团：成员行显示各自 token 消耗', rowTokens >= 2, `rows=${rowTokens}`)
  await pageTeam.screenshot({ path: path.join(OUT, '03b-capabilities-team-gate.png') })
  // 放行一次：decision 下发形状必须带 team/member，扩展那边靠它配对。
  await gateBox.locator('button').filter({ hasText: '放行' }).first().click()
  await pageTeam.waitForTimeout(400)
  const gateDecides = await pageTeam.evaluate(() =>
    window.__PI_STUB__.argCalls.filter((c) => c.cmd === 'agent_team_gate_decide'),
  )
  assert(
    '专家团：放行下发 gate_decide（团队 + 成员齐全）',
    gateDecides.length === 1 && Boolean(gateDecides[0].args.team_id) && Boolean(gateDecides[0].args.member),
    JSON.stringify(gateDecides),
  )
  // 节点级重放（LoopForge replay）：成员行有「重放此节点」按钮；点它深链到对话页，
  // ChatView 消费 query 后必须发一条含 team_replay 的 prompt（工具无反向 RPC，走 agent）。
  const replayBtns = pageTeam.locator('.run-replay-btn')
  assert(
    '专家团：成员运行行带「重放此节点」按钮',
    (await replayBtns.count()) >= 1,
    `count=${await replayBtns.count()}`,
  )
  await replayBtns.first().click()
  await pageTeam
    .waitForFunction(
      () =>
        (window.__PI_STUB__?.argCalls ?? []).some((c) => {
          if (c.cmd !== 'pi_send') return false
          try {
            return JSON.parse(c.args.json).message.includes('team_replay')
          } catch {
            return false
          }
        }),
      { timeout: 6000 },
    )
    .catch(() => {})
  const replayPrompt = await pageTeam.evaluate(() => {
    const sends = (window.__PI_STUB__?.argCalls ?? []).filter((c) => c.cmd === 'pi_send')
    for (let i = sends.length - 1; i >= 0; i--) {
      try {
        const msg = JSON.parse(sends[i].args.json).message
        if (msg.includes('team_replay')) return msg
      } catch {}
    }
    return ''
  })
  assert(
    '专家团：重放深链落对话页并发 team_replay prompt',
    pageTeam.url().includes('/chat') && replayPrompt.includes('team_replay'),
    `${pageTeam.url()} | ${replayPrompt.slice(0, 100)}`,
  )
  await pageTeam.close()
  const capTitle = await page.evaluate(() => {
    const outer = document.querySelector('.wd-market > .market-title')
    const inner = document.querySelector('.agent-ops.embedded .aops-title h1')
    return {
      outer: outer ? parseFloat(getComputedStyle(outer).fontSize) : 0,
      innerDisplay: inner ? getComputedStyle(inner).display : 'missing',
    }
  })
  assert(
    '精细化：六个能力页标题统一在标签栏上方且不重复',
    capTitle.outer >= 25 && capTitle.innerDisplay === 'none',
    JSON.stringify(capTitle),
  )
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

  // ── 8b. 设置页结构（1:1 WorkBuddy：分组侧栏 + 顶部搜索）──────────────
  // routes 末位就是 #/settings，直接在当前页断言。
  assert('设置：侧栏顶部搜索框', (await page.locator('.settings-search input').count()) === 1)
  const settingsGroups = (await page.locator('.settings-nav-group').allInnerTexts()).map((s) => s.trim())
  assert(
    '设置：三组侧栏分组与截图一致',
    JSON.stringify(settingsGroups) === JSON.stringify(['设置', '功能', '数据与安全']),
    JSON.stringify(settingsGroups),
  )
  const settingsNav = (await page.locator('.settings-nav button').allInnerTexts()).map((s) => s.trim())
  const EXPECTED_SETTINGS_NAV = [
    '通用', '个人主页', '套餐与积分', '外观', '快捷键', '关于',
    '个性化', '记忆与进化', '智能体', '模型', '助理', '设备连接', '对话流', '桌面与启动', '工具激活',
    '数据导入', '数据管理', '高级权限',
  ]
  assert(
    '设置：WorkBuddy 截图 15 项 + 我方 3 项全量对齐',
    JSON.stringify(settingsNav) === JSON.stringify(EXPECTED_SETTINGS_NAV),
    JSON.stringify(settingsNav),
  )
  // 搜索联动：输「字号」只剩外观分区，右侧自动跟进到该分区。
  await page.locator('.settings-search input').fill('字号')
  await page.waitForTimeout(250)
  assert('设置：搜索过滤分组', (await page.locator('.settings-nav button').count()) === 2)
  assert(
    '设置：过滤后右侧跟进选中分区',
    (await page.locator('.settings-main h2').first().innerText()).trim() === '外观',
  )
  assert('设置：外观含字号字段', (await page.locator('.settings-main .field.inline').count()) === 2)
  await page.locator('.settings-search input').fill('')
  await page.waitForTimeout(200)
  // 字段对齐：控件列左缘统一（旧 space-between 让控件随标签字数漂移 19px）。
  const fieldLefts = await page.locator('.settings-main .field.inline').evaluateAll((rows) =>
    rows.map((row) => {
      const control = row.children[1] ?? row.querySelector('.app-check')
      return Math.round(control.getBoundingClientRect().left)
    }),
  )
  assert(
    '设置：内联字段控件左缘严格成列',
    fieldLefts.every((x) => x === fieldLefts[0]),
    JSON.stringify(fieldLefts),
  )
  // 精细化：88px 标签列超长文本须截断，不越界压到右侧控件（实测曾溢出 811px）。
  const fieldLabelClip = await page.evaluate(() => {
    const el = document.querySelector('.settings-main .field.inline > span:first-child')
    if (!el) return null
    const old = el.textContent
    el.textContent = '超长设置项名称压力测试'.repeat(8)
    const ok = getComputedStyle(el).textOverflow === 'ellipsis'
    el.textContent = old
    return ok
  })
  assert('精细化：设置标签超长文本有 ellipsis 收口', fieldLabelClip === true, String(fieldLabelClip))
  // 新增入口必须有真实内容：记忆是真实开关 + 本地记忆入口，套餐是诚实说明而非空壳。
  await page.locator('.settings-nav button').filter({ hasText: '记忆与进化' }).click()
  await page.waitForTimeout(150)
  const memoryPane = await page.locator('.settings-main').innerText()
  assert(
    '设置：记忆与进化有真实开关与本地入口',
    memoryPane.includes('本地记忆') && (await page.locator('.settings-main .app-check').count()) >= 1,
    memoryPane.slice(0, 80),
  )
  await page.locator('.settings-nav button').filter({ hasText: '套餐与积分' }).click()
  await page.waitForTimeout(150)
  const billingPane = await page.locator('.settings-main').innerText()
  assert('设置：套餐与积分给出诚实说明', billingPane.includes('没有套餐与积分'), billingPane.slice(0, 80))
  await page.locator('.settings-nav button').filter({ hasText: '通用' }).first().click()
  await page.waitForTimeout(150)
  await page.waitForTimeout(200)

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
const PI_STUB_SCRIPT = STUB_SCRIPT
  // 运行记录：桩默认不实现 pi_journal_sessions，补三条真实形状数据给会话树样式断言。
  const SESSIONS_PATCH = `
(() => {
  const orig = window.__TAURI_INTERNALS__.invoke
  const cwd = '/Users/tatsuma/Documents/GIT/pi-workbench'
  const rows = ['检查当前项目的问题', '只回复 OK', '请分析当前项目'].map((title, i) => ({
    index: i,
    cwd,
    title,
    prompts: 2,
    events: 4,
    started_at_ms: Date.now() - (i + 1) * 86_400_000,
    ended_at_ms: Date.now() - (i + 1) * 86_400_000 + 60_000,
  }))
  window.__TAURI_INTERNALS__.invoke = (cmd, args) =>
    cmd === 'pi_journal_sessions' ? Promise.resolve(rows) : orig(cmd, args)
})()
`
  await page2.addInitScript(PI_STUB_SCRIPT)
  await page2.addInitScript(SESSIONS_PATCH)
  await page2.goto(`http://localhost:${PORT}/#/chat`, { waitUntil: 'load' })
  await page2.waitForTimeout(700)

  // #81：工作区会话树按参考图对齐——文件夹行 + 名称后 chevron + 子行 A 徽标，去掉时间。
  const firstGroup = page2.locator('.sidebar .ws-group').first()
  await firstGroup.waitFor({ timeout: 5000 })
  assert('#81：工作区行带文件夹图标', (await firstGroup.locator('.ws-folder').count()) === 1, '')
  const groupOrder = await firstGroup.evaluate((el) =>
    Array.from(el.children).map((c) => (c.classList ? c.classList.value : c.tagName)),
  )
  const nameIdx = groupOrder.findIndex((c) => c.includes('ws-name'))
  const caretIdx = groupOrder.findIndex((c) => c.includes('ws-caret'))
  const countIdx = groupOrder.findIndex((c) => c.includes('ws-count'))
  assert(
    '#81：chevron 在名称之后、计数之前',
    nameIdx >= 0 && caretIdx > nameIdx && (countIdx < 0 || caretIdx < countIdx),
    JSON.stringify(groupOrder),
  )
  await firstGroup.locator('.ws-caret').click()
  await page2.waitForTimeout(250)
  const runRows = page2.locator('.sidebar .ws-runs .rh-item')
  assert(
    '#88：会话行恢复 ··· 按钮（点击出菜单），A 徽标与时间都不显示',
    (await runRows.count()) > 0 &&
      (await page2.locator('.sidebar .ws-runs .rh-more-btn').count()) === (await runRows.count()) &&
      (await page2.locator('.sidebar .ws-runs .rh-avatar').count()) === 0 &&
      (await page2.locator('.sidebar .ws-runs .rh-time').count()) === 0,
    `rows=${await runRows.count()}`,
  )
  await firstGroup.locator('.ws-caret').click()

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
  if (process.env.DBG_MENU) {
    const dbg = await page2.evaluate(() => ({
      hasStub: typeof window.__PI_STUB__,
      hasTauri: typeof window.__TAURI_INTERNALS__,
      url: location.href,
    }))
    console.log('DBG state:', JSON.stringify(dbg))
    console.log('DBG flowErrors:', flowErrors.slice(0, 4).join(' || ').slice(0, 400))
  }
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
  assert('会话迁移：压缩/导出/导入按钮就位', ioBtns === 3, `btns=${ioBtns}`)
  assert(
    '会话迁移：导出与导入按钮存在',
    (await page2.getByTitle('导出当前会话为 JSON 文件').count()) === 1 &&
      (await page2.getByTitle('从 JSON 文件导入会话').count()) === 1,
    `export=${await page2.getByTitle('导出当前会话为 JSON 文件').count()} import=${await page2.getByTitle('从 JSON 文件导入会话').count()}`,
  )

  // 发出去了就得看得见「在跑」：回答首字到达前必须有 live 步，
  // agent 步骤条也要直接在对话区可见，而不是藏进默认收起的抽屉里。
  // 批 1 F5：等待态不再是自渲染的 `.msg-row.waiting`，收敛为 rail 尾部的 live 步。
  const waitingBubble = await page2.locator('.turn-status').count()
  assert(
    '等待模型响应：回答首字到达前有 live 步占位',
    waitingBubble === 1,
    `count=${waitingBubble}`,
  )
  const stepStrip = await page2.locator('.step-strip').count()
  assert(
    'agent 轨迹：步骤条在对话区直接可见（不必先点开抽屉）',
    stepStrip === 1,
    `count=${stepStrip}`,
  )

  // 头部（P1-6 收紧）：pill 与控制组各是一行控件（内部 trigger 28px + 内衬 2px +
  // 边框 2px = 34px，上限 36），header = 10 + 10 内衬 + 一行控件 + 下边框 ≤ 64。
  // 原来 ≤ 44 / ≤ 104 是在给「两行 header」发通行证，噪声就是这么留下来的。
  const headerBox = await page2.locator('.chat-header').first().boundingBox()
  const pillBox = await page2.locator('.header-pill').first().boundingBox()
  assert(
    '头部：上下文 pill 是一行控件高度（≤36）',
    !!pillBox && pillBox.height <= 36,
    `pill height=${pillBox?.height}`,
  )
  const ctrlBox = await page2.locator('.chat-controls').first().boundingBox()
  assert(
    '头部：控制组是一行控件高度（≤36）',
    !!ctrlBox && ctrlBox.height <= 36,
    `controls height=${ctrlBox?.height}`,
  )
  // flex-wrap:nowrap 后单行是唯一形态：两组控件的垂直中心必须重合。
  assert(
    '头部：选择器组与控制组同在一行（中心线重合）',
    !!pillBox && !!ctrlBox && Math.abs(pillBox.y + pillBox.height / 2 - (ctrlBox.y + ctrlBox.height / 2)) <= 1,
    `pill mid=${pillBox ? (pillBox.y + pillBox.height / 2).toFixed(1) : 'n/a'} controls mid=${
      ctrlBox ? (ctrlBox.y + ctrlBox.height / 2).toFixed(1) : 'n/a'
    }`,
  )
  assert(
    '头部：header 单行（≤64）',
    !!headerBox && headerBox.height <= 64,
    `header height=${headerBox?.height}`,
  )
  // 旧形态下线：系统裸文本（.sys-line）与结果区的复制按钮列（.crow-aside）都不该再出现。
  assert(
    '中栏：旧的系统裸文本行（.sys-line）已下线',
    (await page2.locator('.sys-line').count()) === 0,
    `count=${await page2.locator('.sys-line').count()}`,
  )
  assert(
    '工具展开体：旧的参数/结果 label 列（.crow-aside）已下线',
    (await page2.locator('.crow-aside').count()) === 0,
    `count=${await page2.locator('.crow-aside').count()}`,
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

  // 布局（2026-11-22 用户改判）：对话消息列与输入框等宽——两者共用 --chat-pad 内衬，
  // 内容边线必须落在同一条竖直线上（旧口径「消息全宽 / composer 收窄」已废弃）。
  const widthGeom = await page2.evaluate(() => {
    const center = document.querySelector('.center')
    const msgs = document.querySelector('.msgs')
    const shell = document.querySelector('.composer .composer-shell')
    const strip = document.querySelector('.step-strip')
    if (!center || !msgs || !shell) return null
    const cr = center.getBoundingClientRect()
    const mr = msgs.getBoundingClientRect()
    const sr = shell.getBoundingClientRect()
    const st = strip ? strip.getBoundingClientRect() : null
    // msgs 是滚动容器：clientRect 的 right 含纵向滚动条，内容右缘要先减掉条宽。
    const sb = mr.width - msgs.clientWidth
    return {
      center: Math.round(cr.width),
      msgsLeft: Math.round(mr.left + parseFloat(getComputedStyle(msgs).paddingLeft)),
      msgsRight: Math.round(mr.right - sb - parseFloat(getComputedStyle(msgs).paddingRight)),
      shellLeft: Math.round(sr.left),
      shellRight: Math.round(sr.right),
      stripLeft: st ? Math.round(st.left + parseFloat(getComputedStyle(strip).paddingLeft)) : null,
      stripRight: st ? Math.round(st.right - parseFloat(getComputedStyle(strip).paddingRight)) : null,
    }
  })
  assert(
    '布局：输入框与消息列等宽（左右边线对齐 ≤2px）',
    !!widthGeom &&
      Math.abs(widthGeom.msgsLeft - widthGeom.shellLeft) <= 2 &&
      Math.abs(widthGeom.msgsRight - widthGeom.shellRight) <= 2,
    JSON.stringify(widthGeom),
  )
  assert(
    '布局：步骤行与消息列同对齐线',
    !!widthGeom &&
      widthGeom.stripLeft !== null &&
      Math.abs(widthGeom.msgsLeft - widthGeom.stripLeft) <= 2 &&
      Math.abs(widthGeom.msgsRight - widthGeom.stripRight) <= 2,
    JSON.stringify(widthGeom),
  )

  // 内核不可用时必须**看得见**：失败要落进消息流，不能只在顶部飘一条 6 秒提示。
  // 用户原话「回车或者点击发送的时候没任何反应」——静默失败正是这个 bug 的形状。
  // 先手动收尾上一轮（真实内核必发 agent_settled；非 scripted 桩不会自收），
  // 否则上一轮流式卡着，这条消息会按 G6 语义进队列而不是走 dispatch 失败路径。
  await page2.evaluate(() => window.__PI_STUB__.emitSettled())
  await page2.waitForTimeout(150)
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
    msgsText.includes('内核未响应') || msgsText.includes('下发失败'),
    msgsText.slice(-110),
  )
  await page2.screenshot({ path: path.join(OUT, '36-kernel-unavailable.png') })
  const sysAlign = await page2.evaluate(() => {
    const x = (sel) => {
      const el = document.querySelector(sel)
      return el ? Math.round(el.getBoundingClientRect().x) : null
    }
    return { note: x('.msgs .sys-note'), msgs: x('.msgs'), notice: x('.chat .notice') }
  })
  assert(
    '精细化：系统提示条左缘与消息列/顶栏齐平',
    sysAlign.note !== null &&
      Math.abs(sysAlign.note - (sysAlign.notice ?? sysAlign.msgs ?? sysAlign.note)) <= 2,
    JSON.stringify(sysAlign),
  )
  await page2.evaluate(() => {
    window.__PI_STUB__.failSend = false
  })

  // —— G3「回到此处」：带 checkpoint 的 user 消息可回滚（还原文件 + 重开会话）——
  const rewindBtn = page2.locator('.rewind-btn').first()
  assert(
    'G3：成功发送的 user 消息带「回到此处」按钮',
    (await rewindBtn.count()) >= 1,
    `count=${await rewindBtn.count()}`,
  )
  await rewindBtn.click()
  await page2.waitForTimeout(250)
  const modalText = (await page2.locator('.modal-panel').first().innerText().catch(() => '')).replace(/\s+/g, ' ')
  assert(
    'G3：回滚确认弹窗明示「无法撤销」与 bash 边界',
    modalText.includes('回到此处') && modalText.includes('无法撤销') && modalText.includes('bash'),
    modalText.slice(0, 120),
  )
  // #76 M3：确认框摊开产物态——checkpoint_preview 拉取，restore/delete 分组列出（桩返回 2 还原 + 1 删除）
  const previewCalls = await page2.evaluate(() => window.__PI_STUB__.previewed ?? null)
  assert(
    '#76 G3：打开确认框即调用 checkpoint_preview 且带目标轮 seq',
    !!previewCalls && typeof previewCalls.seq === 'number',
    JSON.stringify(previewCalls),
  )
  assert(
    '#76 G3：弹窗分类清单——将还原（2）/将被删除（1）与文件名摊开',
    modalText.includes('将还原到该轮之前（2）') &&
      modalText.includes('将被删除（1）') &&
      modalText.includes('auth.ts') &&
      modalText.includes('db.ts') &&
      modalText.includes('gen.ts'),
    modalText.slice(0, 260),
  )
  await page2.screenshot({ path: path.join(OUT, '37-rewind-confirm.png') })
  await page2.locator('.modal-panel .btn.danger').first().click()
  await page2.waitForTimeout(400)
  const rewindCalls = await page2.evaluate(() => window.__PI_STUB__.rewound ?? null)
  assert(
    'G3：确认后调用 checkpoint_rewind 且报告落进消息流',
    !!rewindCalls && (await page2.locator('.msgs').innerText()).includes('已回到第'),
    JSON.stringify(rewindCalls),
  )
  await page2.screenshot({ path: path.join(OUT, '38-rewind-done.png') })

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

  // 并行工作区：入口在对话页顶栏（不占一级菜单），点开落在抽屉的 worktree 页签。
  const wtBtn = page2.locator('.wt-toggle').first()
  assert(
    '并行工作区：对话页顶栏有入口按钮',
    (await wtBtn.count()) === 1,
    `count=${await wtBtn.count()}`,
  )
  await wtBtn.click()
  await page2.waitForTimeout(320)
  const wtPane = page2.locator('.trace-drawer.open .wtp').first()
  assert(
    '并行工作区：点击后抽屉落在 worktree 页签并渲染面板',
    (await wtPane.count()) === 1,
    `pane=${await wtPane.count()}`,
  )
  const wtPaneText = (await wtPane.innerText().catch(() => '')).replace(/\s+/g, ' ')
  const wtBranchInput = wtPane.locator('input[placeholder*="新分支名"]')
  assert(
    '并行工作区：面板含分支创建入口与并行舰队',
    (await wtBranchInput.count()) >= 1 && wtPaneText.includes('并行舰队'),
    `input=${await wtBranchInput.count()} text=${wtPaneText.slice(0, 80)}`,
  )
  assert(
    '并行工作区：卡片渲染出分支、状态徽章与端口',
    wtPaneText.includes('main') && wtPaneText.includes('feat/pi-kernel') && wtPaneText.includes('端口'),
    wtPaneText.slice(0, 160),
  )
  // 舰队看板：wt_fleet_list 桩回放一条 done/failed 的舰队，看板卡必须出现。
  assert(
    '并行工作区：舰队看板渲染 lane 状态',
    wtPaneText.includes('舰队看板') && wtPaneText.includes('给轨迹面板补空态') && wtPaneText.includes('task-1'),
    wtPaneText.slice(0, 240),
  )
  // 冲突预测：wt_conflicts 桩给一对 high + 一对 medium，横幅必须亮灯。
  assert(
    '并行工作区：冲突预测横幅显示行相撞与同文件',
    wtPaneText.includes('冲突预测') && wtPaneText.includes('行相撞') && wtPaneText.includes('同文件'),
    wtPaneText.slice(0, 300),
  )
  await page2.screenshot({ path: path.join(OUT, '33b-flow-chat-worktree.png') })
  // 抽屉页签仍应完整（工作区是新增页签，不是替换）
  const wtTabs = await page2.locator('.trace-drawer .td-tab').allInnerTexts()
  assert(
    '并行工作区：抽屉页签齐全（会话树 / 轨迹 / 智能体 / 工作流 / 连接器 / 并行工作区）',
    ['会话树', '轨迹', '智能体', '工作流', '连接器', '并行工作区'].every((l) =>
      wtTabs.some((t) => t.replace(/\s+/g, '').startsWith(l)),
    ),
    wtTabs.map((t) => t.replace(/\s+/g, '')).join('/'),
  )

  // 「在此对话」= 会话切入 worktree：点了必须真换内核工作目录（Pi 的 cwd 只能重启内核换）。
  // 目标卡 = 非当前会话所在的那张（当前会话所在卡的按钮是禁用的）。
  const enterBtn = wtPane
    .locator('.wtp-card', { hasText: 'feat/pi-kernel' })
    .locator('button', { hasText: '在此对话' })
    .first()
  assert('并行工作区：卡片有「在此对话」入口', (await enterBtn.count()) === 1, `count=${await enterBtn.count()}`)
  await enterBtn.click()
  await page2.waitForTimeout(600)
  const afterEnter = await page2.evaluate(() => window.__PI_STUB__.argCalls)
  const piStarts = afterEnter.filter((c) => c.cmd === 'pi_start')
  assert(
    '并行工作区：切入后重启内核并带上 worktree 路径',
    piStarts.some((c) => String(c.args?.cwd ?? '').includes('feat-pi-kernel')),
    JSON.stringify(piStarts.slice(-3)),
  )
  await page2.screenshot({ path: path.join(OUT, '33c-flow-chat-worktree-entered.png') })
  // 切入 worktree 后抽屉应自动收起（对话区让位给新工作区）。
  const drawerAfterEnter = await page2.locator('.trace-drawer.open').count()
  assert('并行工作区：切入后抽屉自动收起', drawerAfterEnter === 0, `open=${drawerAfterEnter}`)

  // 抽屉页签断言已在上面做过；重新打开供后续断言使用。
  await page2.locator('.trace-toggle').first().click()
  await page2.waitForTimeout(300)

  // 智能体分道：内容来自内核事件 + 团队日志，必须真渲染一次，不能只靠类型检查。
  await page2.locator('.trace-drawer .td-tab').filter({ hasText: '智能体' }).first().click()
  await page2.waitForTimeout(300)
  const lanes = page2.locator('.agent-lanes').first()
  assert(
    '智能体分道：面板渲染且有标题',
    (await lanes.count()) === 1 && (await lanes.locator('.al-head').innerText()).includes('智能体分道'),
    'panel missing',
  )
  assert(
    '智能体分道：团队成员按分道展示（含失败态）',
    (await lanes.locator('.al-lane').count()) >= 2 && (await lanes.locator('.al-lane.bad').count()) >= 1,
    `lanes=${await lanes.locator('.al-lane').count()}`,
  )
  const overflow1440 = await lanes.evaluate((el) => el.scrollWidth - el.clientWidth)
  assert('智能体分道：1440 无横向溢出', overflow1440 <= 1, `overflow=${overflow1440}`)
  await page2.screenshot({ path: path.join(OUT, '47-agent-lanes-1440.png') })

  // 右列加宽（流水线横向铺开）：1440 下内联轨 = clamp(380, 34vw, 560) = 489.6。
  const asideGeom = await page2.evaluate(() => {
    const d = document.querySelector('.trace-drawer.open')
    const c = document.querySelector('.chat')
    return {
      w: d ? Math.round(d.getBoundingClientRect().width) : 0,
      cols: c ? getComputedStyle(c).gridTemplateColumns : '',
    }
  })
  assert(
    '过程面板：1440 内联轨加宽到 ~490（34vw）',
    asideGeom.w >= 488 && asideGeom.w <= 491 && !asideGeom.cols.includes('1px'),
    JSON.stringify(asideGeom),
  )
  // 1920 封顶 560，不再吃满中栏。
  await page2.setViewportSize({ width: 1920, height: 1000 })
  await page2.waitForTimeout(250)
  const asideWide = await page2.evaluate(() => {
    const d = document.querySelector('.trace-drawer.open')
    return d ? Math.round(d.getBoundingClientRect().width) : 0
  })
  assert('过程面板：1920 封顶 560', asideWide >= 559 && asideWide <= 561, `w=${asideWide}`)
  await page2.screenshot({ path: path.join(OUT, '47b-agent-lanes-1920.png') })
  // 1076 仍内联（断点下沿）；1075 起转 overlay，中栏不再为右列留轨。
  await page2.setViewportSize({ width: 1076, height: 900 })
  await page2.waitForTimeout(250)
  const asideMinInline = await page2.evaluate(() => {
    const d = document.querySelector('.trace-drawer.open')
    const c = document.querySelector('.chat')
    return {
      w: d ? Math.round(d.getBoundingClientRect().width) : 0,
      pos: d ? getComputedStyle(d).position : '',
      cols: c ? getComputedStyle(c).gridTemplateColumns.split(' ').length : 0,
    }
  })
  assert(
    '过程面板：1076 仍内联且下限 380',
    asideMinInline.w === 380 && asideMinInline.pos === 'static' && asideMinInline.cols === 2,
    JSON.stringify(asideMinInline),
  )
  await page2.setViewportSize({ width: 1075, height: 900 })
  await page2.waitForTimeout(250)
  const asideOverlay = await page2.evaluate(() => {
    const d = document.querySelector('.trace-drawer.open')
    const c = document.querySelector('.chat')
    return {
      pos: d ? getComputedStyle(d).position : '',
      w: d ? Math.round(d.getBoundingClientRect().width) : 0,
      cols: c ? getComputedStyle(c).gridTemplateColumns.split(' ').length : 0,
      pad: c ? getComputedStyle(document.querySelector('.chat .center')).paddingRight : '',
    }
  })
  assert(
    '过程面板：1075 转 overlay 且中栏让位',
    asideOverlay.pos === 'absolute' && asideOverlay.w === 380 && asideOverlay.cols === 1 && asideOverlay.pad !== '0px',
    JSON.stringify(asideOverlay),
  )
  // 851 以下整屏覆盖，中栏不再让位。
  await page2.setViewportSize({ width: 851, height: 900 })
  await page2.waitForTimeout(250)
  const asideFull = await page2.evaluate(() => {
    const d = document.querySelector('.trace-drawer.open')
    const c = document.querySelector('.chat .center')
    return {
      w: d ? Math.round(d.getBoundingClientRect().width) : 0,
      pad: c ? getComputedStyle(c).paddingRight : '',
    }
  })
  assert(
    '过程面板：851 整屏覆盖且中栏不让位',
    asideFull.w > 500 && asideFull.pad === '0px',
    JSON.stringify(asideFull),
  )
  await page2.setViewportSize({ width: 1440, height: 900 })
  await page2.waitForTimeout(200)

  await page2.setViewportSize({ width: 390, height: 844 })
  await page2.waitForTimeout(250)
  const overflow390 = await lanes.evaluate((el) => el.scrollWidth - el.clientWidth)
  assert('智能体分道：390 无横向溢出', overflow390 <= 1, `overflow=${overflow390}`)
  await page2.screenshot({ path: path.join(OUT, '48-agent-lanes-390.png') })
  const tdNarrow = await page2.evaluate(() => {
    const box = document.querySelector('.trace-drawer .td-tabs')
    const tabs = [...(box?.querySelectorAll('.td-tab') ?? [])]
    const last = tabs[tabs.length - 1]
    return {
      count: tabs.length,
      shrink: last ? getComputedStyle(last).flexShrink : '',
      lastW: last?.offsetWidth ?? 0,
      lastScroll: last?.scrollWidth ?? 0,
      overflow: box ? box.scrollWidth - box.clientWidth : -1,
      lastRight: last ? Math.round(last.getBoundingClientRect().right) : 0,
      boxRight: box ? Math.round(box.getBoundingClientRect().right) : 0,
    }
  })
  assert(
    '精细化：390 抽屉六个页签完整可见不裁切',
    tdNarrow.count === 6 &&
      tdNarrow.shrink === '0' &&
      tdNarrow.lastW >= tdNarrow.lastScroll - 1 &&
      tdNarrow.overflow <= 1 &&
      tdNarrow.lastRight <= tdNarrow.boxRight + 1,
    JSON.stringify(tdNarrow),
  )
  await page2.setViewportSize({ width: 1440, height: 900 })
  await page2.waitForTimeout(200)

  // 过程面板之外的工具（文件 / 终端 / 浏览器）归项目详情页。
  // 从侧栏项目行的「工作台」入口过去 —— 这条入口本身也是这版新加的。
  // 全流程：侧栏项目行的工作台入口能进项目详情页。
  // 计划项种子必须在进页**之前**灌：ProjectWorkspace 只在 onMounted 拉一次快照，
  // 进页后再改 __PI_STUB__.wi，视图根本看不到新数据。
  await page2.evaluate(() => {
    const now = Date.now()
    window.__PI_STUB__.wi = [
      {
        id: 'wi-seed-1',
        project_id: 'p-flow-b',
        title: '补轨迹面板空态',
        status: 'todo',
        assignee: '',
        priority: 'p1',
        tags: ['ui'],
        revision: 'r-seed-1',
        created_at: now,
        updated_at: now,
      },
      {
        id: 'wi-seed-2',
        project_id: 'p-flow-b',
        title: '舰队看板轮询',
        status: 'doing',
        assignee: 'me',
        priority: 'p0',
        tags: [],
        revision: 'r-seed-2',
        created_at: now,
        updated_at: now,
      },
    ]
  })
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
    '项目详情页：文件 / 终端 / 浏览器 / 并行工作区四个工具面都在',
    ['文件', '终端', '浏览器', '并行工作区'].every((l) => pwTabs.includes(l)),
    pwTabs.join('/'),
  )
  // 头部「并行工作区」按钮：绑了目录的项目才有（app.path 分支要测到真渲染）。
  assert(
    '项目详情页：头部有「并行工作区」直达按钮',
    (await page2.locator('.pw-open-wt').count()) === 1,
    '',
  )
  // 内嵌工作树面板：tab 切换后应真渲染面板（舰队/冲突预测随之带进工作台）。
  await page2.locator('.pw-tab').filter({ hasText: '并行工作区' }).first().click()
  await page2.waitForTimeout(400)
  assert(
    '项目详情页：并行工作区 tab 内嵌工作树面板',
    (await page2.locator('.pw-body .wtp').count()) === 1,
    `wtp=${await page2.locator('.pw-body .wtp').count()}`,
  )

  // 计划项细修：筛选条 + 就地编辑（种子已在进页前灌好）。
  await page2.locator('.pw-tab').filter({ hasText: '计划项' }).first().click()
  await page2.waitForTimeout(350)
  const wiRows = page2.locator('.pw-body .pw-list .pw-row')
  assert(
    '计划项：种子数据渲染出两行',
    (await wiRows.count()) === 2,
    `rows=${await wiRows.count()}`,
  )
  assert('计划项：筛选条渲染', (await page2.locator('.pw-filterbar').count()) === 1, '')
  await page2.locator('.pw-filterbar .app-select .trigger').first().click()
  await page2.waitForTimeout(150)
  await page2.locator('.app-select .menu .opt').filter({ hasText: '进行中' }).first().click()
  await page2.waitForTimeout(250)
  assert(
    '计划项：按状态筛选只剩一行',
    (await wiRows.count()) === 1 && (await page2.locator('.pw-filterbar').innerText()).includes('1 / 2'),
    `rows=${await wiRows.count()} bar="${(await page2.locator('.pw-filterbar').innerText()).replace(/\s+/g, ' ')}"`,
  )
  // 复位到「全部」再编辑（筛选是视图态，不该影响编辑链路）。
  await page2.locator('.pw-filterbar .app-select .trigger').first().click()
  await page2.waitForTimeout(150)
  await page2.locator('.app-select .menu .opt').filter({ hasText: '全部' }).first().click()
  await page2.waitForTimeout(200)
  await page2.locator('.pw-row-main').filter({ hasText: '补轨迹面板空态' }).first().click()
  await page2.waitForTimeout(250)
  const editFields = await page2.locator('.modal-panel .pw-edit-field').count()
  assert('计划项：点行弹出就地编辑（5 个字段）', editFields === 5, `fields=${editFields}`)
  const titleInput = page2.locator('.modal-panel .pw-edit-field').first().locator('.app-input')
  await titleInput.fill('补轨迹面板空态（已修订）')
  await page2.locator('.modal-panel .modal-footer .pw-primary').click()
  await page2.waitForTimeout(400)
  const wiUpdate = await page2.evaluate(() =>
    window.__PI_STUB__.argCalls.filter((c) => c.cmd === 'project_update_work_item'),
  )
  assert(
    '计划项：保存走乐观锁修订下发',
    wiUpdate.length === 1 &&
      JSON.stringify(wiUpdate[0].args.patch?.tags) === '["ui"]' &&
      wiUpdate[0].args.expected_revision === 'r-seed-1',
    JSON.stringify(wiUpdate),
  )
  assert(
    '计划项：编辑后列表回显新标题',
    (await page2.locator('.pw-row-main strong').filter({ hasText: '（已修订）' }).count()) === 1,
    '',
  )
  await page2.screenshot({ path: path.join(OUT, '33d-project-workitems.png') })

  await page2.locator('.pw-tab').filter({ hasText: '文件' }).first().click()
  await page2.waitForTimeout(350)
  assert(
    '项目详情页：文件面渲染出文件树 + 编辑面板',
    (await page2.locator('.fws-tree').count()) === 1 && (await page2.locator('.fedit').count()) === 1,
    '',
  )
  await page2.screenshot({ path: path.join(OUT, '34-project-files.png') })
  const pwInset = await page2.evaluate(() => {
    const x = (sel) => {
      const el = document.querySelector(sel)
      return el ? Math.round(el.getBoundingClientRect().x) : null
    }
    return { tabs: x('.pw-tabs'), body: x('.pw.tool .pw-body') }
  })
  assert(
    '精细化：工具页签与内容区左缘对齐',
    pwInset.tabs !== null && Math.abs(pwInset.tabs - pwInset.body) <= 1,
    JSON.stringify(pwInset),
  )
  await page2.locator('.pw-tab').filter({ hasText: '终端' }).first().click()
  await page2.waitForTimeout(350)
  assert('项目详情页：终端面渲染', (await page2.locator('.pw-body .term').count()) === 1, '')
  await page2.locator('.pw-tab').filter({ hasText: '浏览器' }).first().click()
  await page2.waitForTimeout(350)
  assert('项目详情页：浏览器面渲染', (await page2.locator('.pw-body .agent-browser').count()) === 1, '')
  await page2.screenshot({ path: path.join(OUT, '35-project-browser.png') })

  // 深链：「并行工作区」按钮 → 对话页抽屉自动落到 worktree 页签。
  // 舰队看板 / 冲突预测断言原本靠顶栏按钮开抽屉，现在这条链路走的是项目页入口。
  await page2.locator('.pw-open-wt').click()
  await page2.waitForTimeout(800)
  assert(
    '深链：「并行工作区」落到对话页且 URL 带 panel=worktree',
    page2.url().includes('/chat') && page2.url().includes('panel=worktree'),
    page2.url(),
  )
  assert(
    '深链：抽屉自动展开并落在并行工作区页签',
    (await page2.locator('.trace-drawer.open').count()) === 1 &&
      (await page2.locator('.td-tab.on').innerText()).includes('并行工作区'),
    (await page2.locator('.td-tab.on').innerText().catch(() => 'none')).trim(),
  )
  assert(
    '深链：工作区面板渲染（舰队看板 + 冲突预测）',
    (await page2.locator('.wtp').count()) === 1 &&
      (await page2.locator('.wtp-fleets').count()) === 1 &&
      (await page2.locator('.wtp-clashes').count()) === 1,
    '',
  )
  await page2.screenshot({ path: path.join(OUT, '33e-deeplink-worktree.png') })

  // 从项目页回对话页：ChatView 会重新挂载，但共享的活动项目**没变**
  // （ref 不变 → watcher 不触发），工作目录必须靠自己补同步。
  await page2.goto(`http://localhost:${PORT}/#/projects/p-flow-b`, { waitUntil: 'load' })
  await page2.waitForTimeout(700)
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
  await page2.locator('.side-panel .ws-new').click()
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
  const enabledFlags = await page2.locator('.market-row .row-install').count()
  assert('插件市场：每行显示启用状态', enabledFlags >= 1, `flags=${enabledFlags}`)
  await page2.screenshot({ path: path.join(OUT, '39-plugins-real.png') })

  // #78 扩展管理开关：加载层（物理搬运）/ 工具层（defaultTools）/ 卸载三层各自可点，
  // 内置扩展只读、URL 装的能删——桩维护同一份内存状态，断言 UI 真收敛。
  const pExt = (name) => page2.locator('.market-row').filter({ hasText: name })
  assert(
    '#78：内置扩展删除键禁用、外装扩展删除键可用',
    (await pExt('长期记忆').locator('.row-remove').isDisabled()) &&
      !(await pExt('链接安装的扩展').locator('.row-remove').isDisabled()),
    'builtin-disabled / installed-enabled',
  )
  await pExt('浏览器会话').locator('.row-load').click()
  await page2.waitForTimeout(250)
  const extToggles = await page2.evaluate(() => window.__PI_STUB__.extToggles ?? [])
  assert(
    '#78：加载开关调 extensions_set_enabled 且 UI 收敛为「加载」',
    extToggles.some((x) => x.id === 'agent-browser-session.ts' && x.enabled === false) &&
      (await pExt('浏览器会话').locator('.row-load').innerText()).includes('加载') &&
      (await pExt('浏览器会话').locator('.row-tag.off').count()) === 1 &&
      (await pExt('浏览器会话').count()) === 1,
    JSON.stringify(extToggles),
  )
  await pExt('链接安装的扩展').locator('.row-remove').click()
  await page2.waitForTimeout(250)
  const extRemoved = await page2.evaluate(() => window.__PI_STUB__.extRemoved ?? [])
  assert(
    '#78：卸载调 extensions_remove 且该行从清单消失',
    extRemoved.includes('from-url.ts') && (await pExt('链接安装的扩展').count()) === 0,
    JSON.stringify(extRemoved),
  )
  const allOffBtn = page2.locator('.market-tools .text-btn').filter({ hasText: '全部停用' })
  assert('#78：排查入口「全部停用」存在', (await allOffBtn.count()) === 1, `btn=${await allOffBtn.count()}`)
  await allOffBtn.click()
  await page2.waitForTimeout(300)
  const toggledAll = await page2.evaluate(() => window.__PI_STUB__.extToggles ?? [])
  assert(
    '#78：一键全关下发每条扩展的停用调用',
    toggledAll.filter((x) => x.enabled === false).length >= 2,
    JSON.stringify(toggledAll.slice(-4)),
  )
  await page2.screenshot({ path: path.join(OUT, '39b-plugins-switches.png') })

  // #77 M5 推荐源：扩展在 agent_before_settle 写 custom entry，桥转 entry_appended，
  // 前端 composer 上方出三条 chip；填入不自动发、换一批轮转、关闭隐藏。
  await page2.goto(`http://localhost:${PORT}/#/chat`, { waitUntil: 'load' })
  await page2.waitForFunction(() => (window.__PI_STUB__?.listeners?.['pi://event'] ?? []).length > 0, null, { timeout: 5000 }).catch(() => {})
  // 首页无会话态 composer：先发一条进会话（hero-send 走 stub 桩自动选目录）。
  await page2.locator('.hero-input-wrap .app-textarea').first().click()
  await page2.keyboard.type('开个会话')
  await page2.locator('.hero-send').click()
  await page2.waitForTimeout(700)
  await page2.evaluate(() => window.__PI_STUB__.emitPi({
    type: 'entry_appended',
    entry: { type: 'custom', customType: 'pi_suggest', data: { suggestions: ['接着做甲', '给甲补测试', '换个角度查甲'] } },
  }))
  await page2.waitForTimeout(250)
  const sChips = page2.locator('.suggest-chip')
  assert('#77：entry_appended 产出三条推荐 chip', (await sChips.count()) === 3, `chips=${await sChips.count()}`)
  assert('#77：推荐 chip 显示真实文本', (await sChips.first().innerText()).includes('接着做甲'), await sChips.first().innerText())
  // #90：浮层覆盖在输入框上方，不占消息列高度（对齐 workbuddy 遮盖弹窗）。
  const suggestBox = await page2.evaluate(() => {
    const el = document.querySelector('.suggest-chips')
    const box = document.querySelector('.composer .input-wrap')
    if (!el || !box) return null
    const cs = getComputedStyle(el)
    const r = el.getBoundingClientRect()
    const b = box.getBoundingClientRect()
    return { pos: cs.position, z: cs.zIndex, bottom: Math.round(r.bottom), composerTop: Math.round(b.top) }
  })
  assert(
    '#90：推荐 chip 为浮层且覆盖输入框上沿',
    !!suggestBox && suggestBox.pos === 'absolute' && suggestBox.bottom <= suggestBox.composerTop + 8,
    JSON.stringify(suggestBox),
  )
  await sChips.first().click()
  await page2.waitForTimeout(150)
  const draftAfterPick = await page2.locator('.composer textarea').first().inputValue().catch(() => '')
  const sentAfterPick = await page2.evaluate(() => window.__PI_STUB__.lastSent ?? '')
  assert('#77：点 chip 填入草稿且不自动发送', draftAfterPick.includes('接着做甲') && !sentAfterPick.includes('接着做甲'), `draft=${draftAfterPick.slice(0, 40)} sent=${sentAfterPick.slice(0, 40)}`)
  await page2.locator('.suggest-act').first().click()
  await page2.waitForTimeout(150)
  assert('#77：换一批轮转顺序', (await sChips.first().innerText()).includes('给甲补测试'), await sChips.first().innerText())
  await page2.locator('.suggest-act').nth(1).click()
  await page2.waitForTimeout(150)
  assert('#77：关闭推荐后 chip 消失', (await sChips.count()) === 0, `chips=${await sChips.count()}`)
  await page2.screenshot({ path: path.join(OUT, '39c-suggest-chip.png') })

  // #79 切窗态保留：切到别的路由再回来，过程抽屉与专家 chip 不该丢。
  // 回归用户截图病灶——切走再切回，右侧面板整块消失、专家 chip 空。
  assert('#79：拖拽带在所有页面共用且带 Tauri 属性', (await page2.locator('.app-main > .drag-strip[data-tauri-drag-region]').count()) === 1, `strip=${await page2.locator('.drag-strip').count()}`)
  await page2.locator('.chat-controls .trace-toggle').first().click()
  await page2.waitForTimeout(200)
  const asideBefore = await page2.locator('.chat.aside-open').count()
  assert('#79：过程抽屉可展开', asideBefore === 1, `aside=${asideBefore}`)
  await page2.goto(`http://localhost:${PORT}/#/plugins`, { waitUntil: 'load' })
  await page2.waitForTimeout(400)
  assert('#79：切到插件页拖拽带仍在', (await page2.locator('.app-main > .drag-strip[data-tauri-drag-region]').count()) === 1, `strip=${await page2.locator('.drag-strip').count()}`)
  await page2.goto(`http://localhost:${PORT}/#/chat`, { waitUntil: 'load' })
  await page2.waitForTimeout(500)
  assert('#79：切页再回来过程抽屉保持展开', (await page2.locator('.chat.aside-open').count()) === 1, `aside=${await page2.locator('.chat.aside-open').count()}`)
  // 恢复干净态：抽屉是模块级会话态，不关会挡住后续测试的 composer 点击。
  await page2.locator('.trace-drawer .td-close').first().click().catch(() => {})
  await page2.waitForTimeout(150)

  await page2.goto(`http://localhost:${PORT}/#/library`, { waitUntil: 'load' })
  await page2.waitForTimeout(600)
  const libNodes = await page2.locator('.tree-node').count()
  assert('资料库：目录树渲染出节点（非空壳）', libNodes >= 2, `nodes=${libNodes}`)
  const libTreeText = await page2.locator('.lib-tree').innerText().catch(() => '')
  // 只数节点会被「节点在、内容空」骗过：目录名与文件名必须真的显示出来。
  assert('资料库：目录树显示目录名与文件名', libTreeText.includes('docs') && libTreeText.includes('会议纪要.md'), JSON.stringify(libTreeText.slice(0, 80)))
  const libQuota = await page2.locator('.lib-quota').count()
  assert('资料库：配额卡渲染', libQuota === 1, `quota=${libQuota}`)
  // 字段名对不上时卡片仍在，但字节会显示成 undefined、占用条固定 0%。
  const quotaText = await page2.locator('.lib-quota').innerText().catch(() => '')
  assert('资料库：配额显示真实份数与字节', quotaText.includes('2 份') && quotaText.includes('6.0 KiB') && quotaText.includes('100.00 MiB'), JSON.stringify(quotaText))
  const quotaWidth = await page2.locator('.lib-quota .quota-bar > span').first().evaluate((el) => (el ? el.style.getPropertyValue('--quota-w') : '')).catch(() => '')
  assert('资料库：占用比例按 6144/100MiB 渲染（非 0）', parseFloat(quotaWidth) > 0, `--quota-w=${quotaWidth}`)
  await page2.screenshot({ path: path.join(OUT, '40-library-real.png') })

  await page2.goto(`http://localhost:${PORT}/#/capabilities?tab=skill`, { waitUntil: 'load' })
  await page2.waitForTimeout(500)
  const skillCards = await page2.locator('.market-card').count()
  assert('能力中心：技能列表渲染', skillCards >= 1, `cards=${skillCards}`)
  await page2.screenshot({ path: path.join(OUT, '41-capabilities-real.png') })

  // ── 9c. 专家中心：提示词可编辑、执行配置只读可查、persona 预览走后端编译 ──
  await page2.goto(`http://localhost:${PORT}/#/capabilities?tab=expert`, { waitUntil: 'load' })
  await page2.waitForTimeout(600)
  // 先塞一份带执行配置的草稿：只读区块要渲染出真值，而不是「未设置」。
  await page2.evaluate(() => {
    window.__PI_STUB__.drafts['code-reviewer'] = {
      definition: {
        name: 'code-reviewer',
        description: '审查改动',
        role: '只读审查，不改代码。',
        methodology: '先看 diff 再看测试',
        boundaries: '不碰生产配置',
        deliverables: '风险清单',
        tags: ['评审'],
        examples: [],
        skill_requirements: [{ name: 'pdf' }],
        allowed_tools: ['read', 'grep'],
        denied_patterns: ['git push'],
        stop_condition: '给出结论即停',
        max_iterations: 12,
        tool_mapping: [{ from: 'external_lint', to: 'bash', decision: 'mapped' }],
        executor: 'claude',
        model: 'sonnet',
        rules: '禁止改测试文件',
        mcp_servers: ['codebase'],
      },
      revision: 2,
      digest: 'c'.repeat(16),
      updated_at: Date.now(),
      source: 'local',
    }
  })
  await page2.locator('.market-tools .app-btn', { hasText: '新建专家' }).first().click()
  await page2.waitForTimeout(300)
  assert('专家创建：弹出新建对话框', (await page2.locator('.modal-backdrop .modal-panel').count()) === 1)
  await page2.locator('.modal-body .app-input').first().fill('code-reviewer')
  await page2.locator('.modal-footer .app-btn', { hasText: '打开编辑器' }).first().click()
  await page2.waitForTimeout(900)

  // 执行配置只读区：有分隔头、没有任何勾选控件（工具门不再是可编辑文本）。
  const roHead = await page2.locator('.ed-readonly-head').count()
  const toolBoxes = await page2.locator('.ed-tools .app-check').count()
  const chipTexts = (await page2.locator('.ed-chip').allInnerTexts()).map((s) => s.trim())
  assert(
    '专家中心：执行配置只读区存在且无工具勾选',
    roHead === 1 && toolBoxes === 0,
    `head=${roHead} boxes=${toolBoxes}`,
  )
  assert(
    '专家中心：工具门 / 拒绝模式 / MCP / 技能以只读芯片展示',
    chipTexts.includes('read') && chipTexts.includes('grep') && chipTexts.includes('git push') && chipTexts.includes('codebase') && chipTexts.includes('pdf'),
    chipTexts.slice(0, 8).join(','),
  )
  const roPane = (await page2.locator('.ed-col').innerText().catch(() => '')).replace(/\s+/g, ' ')
  assert(
    '专家中心：执行器 / 模型 / 硬规则 / 迭代上限只读可见',
    roPane.includes('claude') && roPane.includes('sonnet') && roPane.includes('禁止改测试文件') && roPane.includes('12'),
    roPane.slice(0, 200),
  )
  // persona 预览来自后端 expert_persona_preview（桩返回编译后的 full，含硬规则段）。
  const personaPre = (await page2.locator('.ed-pre').innerText().catch(() => '')).replace(/\s+/g, ' ')
  assert(
    '专家中心：persona 预览走后端编译（含硬规则段）',
    personaPre.includes('你是「code-reviewer」') && personaPre.includes('## 硬规则'),
    personaPre.slice(0, 120),
  )
  // 提示词字段仍可编辑：改名称 → 保存 → 列表回显。
  await page2.locator('.ed-field .app-input').nth(1).fill('代码评审专家')
  await page2.locator('.ed-head-actions .app-btn', { hasText: '保存草稿' }).first().click()
  await page2.waitForTimeout(800)
  const savedExperts = await page2.evaluate(() => window.__PI_STUB__.experts)
  assert(
    '专家中心：保存草稿并保留只读执行配置的工具数',
    savedExperts.length === 1 && savedExperts[0].tool_count === 2,
    JSON.stringify(savedExperts.map((e) => [e.id, e.tool_count])),
  )
  // 编辑在弹窗里完成：关掉弹窗回到卡片网格，列表页不再有常驻表单。
  await page2.locator('.modal-panel.page .modal-close').first().click()
  await page2.waitForTimeout(400)
  const editModalGone = await page2.locator('.modal-panel.page').count()
  assert('专家编辑：弹窗关闭后列表页无残留表单', editModalGone === 0, `panels=${editModalGone}`)
  const cardCount = await page2.locator('.expert-card').count()
  assert('专家市场：卡片网格渲染（WorkBuddy 式）', cardCount === 1, `cards=${cardCount}`)
  const cardText = (await page2.locator('.expert-card').first().innerText().catch(() => '')).replace(/\s+/g, ' ')
  assert(
    '专家卡片：名称/简介/工具数/来源/运行状态一眼可见',
    cardText.includes('代码评审专家') && cardText.includes('审查改动') &&
      cardText.includes('2 个工具') && cardText.includes('本地创建') && cardText.includes('最近运行成功'),
    cardText.slice(0, 160),
  )
  // 点「编辑」重新拉起弹窗（用户「要编辑某个专家直接点编辑就好弹窗」）。
  await page2.locator('.expert-card .expert-edit-btn').first().click()
  await page2.waitForTimeout(500)
  const reopen = await page2.locator('.modal-panel.page .ed').count()
  assert('专家卡片：点「编辑」弹窗重开且表单在内', reopen === 1, `ed=${reopen}`)
  await page2.locator('.modal-panel.page .modal-close').first().click()
  await page2.waitForTimeout(300)
  await page2.screenshot({ path: path.join(OUT, '41b-expert-cards.png') })

  // ── 9d. WorkBuddy 缓存一键导入：扫描 → 勾选 → 批量预览 → 导入 + 顺手建团 ──
  await page2.locator('.market-tools .app-btn', { hasText: '导入专家' }).first().click()
  await page2.waitForTimeout(700)
  const packRows = page2.locator('.import-pack-list .import-pack')
  const packCount = await packRows.count()
  assert('导入扫描：缓存清单渲染出包（非空壳）', packCount === 3, `rows=${packCount}`)
  const scanRoot = (await page2.locator('.import-root code').innerText().catch(() => '')).trim()
  assert('导入扫描：显示扫描目录（~ 缩写，回答「路径在哪」）', scanRoot.includes('~/.workbuddy/plugins/cache/experts'), scanRoot)
  const crewRow = (await page2.locator('.import-pack', { hasText: '代码之舟' }).innerText().catch(() => '')).replace(/\s+/g, ' ')
  assert('导入扫描：团队包带「团队」徽标与牵头人', crewRow.includes('团队') && crewRow.includes('牵头'), crewRow)
  const brokenDisabled = await page2.locator('.import-pack.off', { hasText: 'broken-pack' }).count()
  assert('导入扫描：解析失败的包置灰且不可勾', brokenDisabled === 1, `off=${brokenDisabled}`)
  await page2.screenshot({ path: path.join(OUT, '41c-import-scan.png') })
  // 默认全选好包、坏包不勾：预览按钮应带 2 个包
  await page2.locator('.modal-footer .app-btn', { hasText: '预览' }).first().click()
  await page2.waitForTimeout(700)
  const importCards = await page2.locator('.import-card').count()
  assert('导入预览：跨包合并出 3 位专家卡片', importCards === 3, `cards=${importCards}`)
  const teamTag = await page2.locator('.import-card .import-badge.team').count()
  assert('导入预览：团队包成员标注「团队」来源', teamTag === 2, `tags=${teamTag}`)
  // 回归：未映射工具带 suggestion 时前端自动采纳，不该卡住导入按钮（截图「导不进去」真因）。
  const pendingBlock = await page2.locator('.import-pending').count()
  assert('导入预览：有建议的未映射工具自动采纳，无待处理阻塞', pendingBlock === 0, `pendingBlocks=${pendingBlock}`)
  const applyBtn = page2.locator('.modal-footer .app-btn', { hasText: '导入' }).first()
  assert('导入预览：导入按钮可用（不再因建议工具卡死）', await applyBtn.isEnabled())
  const autoMapped = await page2.evaluate(() => {
    const s = window.__PI_STUB__
    const card = document.querySelector('.import-card')
    return { unmapped: s?.scanPackages?.find((p) => p.slug === 'solo-reviewer')?.experts?.[0]?.unmapped_tools?.[0] ?? null }
  })
  assert('导入预览：Read 工具带后端建议 read', autoMapped.unmapped?.suggestion === 'read', JSON.stringify(autoMapped))
  // 无建议的 Grep/Glob：默认「忽略（内核没有）」，不再显示「待决定」逼用户猜。
  const toolRows = await page2.locator('.import-tool-row').allInnerTexts()
  const grepRow = toolRows.find((t) => t.includes('Grep')) ?? ''
  const globRow = toolRows.find((t) => t.includes('Glob')) ?? ''
  assert(
    '导入预览：内核没有的 Grep/Glob 默认标注忽略，无「待决定」',
    grepRow.includes('忽略') && globRow.includes('忽略') &&
      !grepRow.includes('待决定') && !globRow.includes('待决定'),
    `grep=${grepRow.replace(/\s+/g, ' ')} | glob=${globRow.replace(/\s+/g, ' ')}`,
  )
  await page2.screenshot({ path: path.join(OUT, '41d-import-detail.png') })
  await page2.locator('.modal-footer .app-btn', { hasText: '导入' }).first().click()
  await page2.waitForTimeout(900)
  const importedIds = await page2.evaluate(() => window.__PI_STUB__.experts.map((e) => e.id))
  assert(
    '导入落盘：3 位专家进入清单',
    ['code-crew-team-lead', 'code-crew-first-engineer', 'solo-reviewer'].every((id) => importedIds.includes(id)),
    JSON.stringify(importedIds),
  )
  const stubTeams = await page2.evaluate(() => window.__PI_STUB__.teams ?? [])
  const crewTeam = stubTeams.find((tm) => tm.name === '代码之舟')
  assert(
    '导入建团：团队包顺手建团，成员带 e: 前缀且牵头人在册',
    !!crewTeam && crewTeam.members.length === 2 && crewTeam.members.every((m) => m.startsWith('e:')) && crewTeam.lead === 'e:code-crew-team-lead',
    JSON.stringify(crewTeam ?? null),
  )
  const notice = (await page2.locator('.expert-list-notice').innerText().catch(() => '')).replace(/\s+/g, ' ')
  assert('导入回执：专家数与建团结果同条展示', notice.includes('已导入 3 个专家') && notice.includes('代码之舟'), notice)
  const srcTags = await page2.locator('.expert-card .tag-source').allInnerTexts()
  assert('导入专家卡片：来源标「导入」', srcTags.filter((s) => s.trim() === '导入').length === 3, JSON.stringify(srcTags))
  // 回归（截图真因）：团队成员导入后各自有名字，不再整团塌成包名重复一排。
  const cardNames = (await page2.locator('.expert-card .card-name').allInnerTexts()).map((s) => s.trim())
  assert(
    '导入专家卡片：成员名各自独立、无同名堆叠',
    new Set(cardNames).size === cardNames.length && cardNames.includes('团队牵头人') && cardNames.includes('主任工程师'),
    JSON.stringify(cardNames),
  )
  await page2.screenshot({ path: path.join(OUT, '41e-import-done.png') })

  // ── 9e. 首页召唤形态（1:1 WorkBuddy + 菜单）：+ 号收 添加文件/模式/专家/技能/连接器/角色，
  // 专家子菜单 = 搜索 + 头像名册 + 「召唤更多专家」底栏。独立的专家/角色触发器已砍
  // （用户截图病灶「这俩是不是重复」：触发器与 chip 双源展示），选中态只以 chip 呈现。──
  await page2.goto(`http://localhost:${PORT}/#/chat`, { waitUntil: 'load' })
  await page2.waitForTimeout(700)
  // goto 会重跑桩脚本、把活动项目清空；角色是项目级配置，不先绑目录「角色」行
  // 永远禁用，它的当前值分支就测不到。走侧栏点击（router.push，不重载）。
  await page2.locator('.sidebar .ws-list li').filter({ hasText: 'pi-workbench' }).first().click()
  await page2.waitForTimeout(700)
  const plusBtn = page2.locator('.hero-input-wrap .cpm-trigger')
  assert('首页：+ 召唤菜单挂在输入框工具条', (await plusBtn.count()) === 1, `count=${await plusBtn.count()}`)
  assert('首页：旧独立专家触发器已移除', (await page2.locator('.ep-trigger').count()) === 0)
  assert('首页：旧角色选择器已移除', (await page2.locator('.role-switcher').count()) === 0)
  await plusBtn.click()
  await page2.waitForTimeout(300)
  const cpmRows = page2.locator('.cpm-menu .cpm-row')
  assert('#93：+ 菜单七行能力入口（含引用对话中的文件）', (await cpmRows.count()) === 7, `rows=${await cpmRows.count()}`)
  const rootLabels = (await cpmRows.locator('.cpm-row-label').allInnerTexts()).map((s) => s.trim())
  assert(
    '+ 菜单：行名与 WorkBuddy 对齐',
    ['添加文件', '引用对话中的文件', '模式', '专家', '技能', '连接器', '角色'].every((n) => rootLabels.includes(n)),
    JSON.stringify(rootLabels),
  )
  // 1:1 WorkBuddy 规格：紧凑宽 320 / 六行 × 46 / 图标 18 / 首行浅底 + 三列严格对齐。
  const cpmBox = await page2.locator('.cpm-menu').boundingBox()
  assert(
    '+ 菜单：面板尺寸（320 宽，七行封顶 ≤580 高）',
    !!cpmBox && Math.abs(cpmBox.width - 320) <= 2 && cpmBox.height <= 580,
    cpmBox ? `${Math.round(cpmBox.width)}×${Math.round(cpmBox.height)}` : 'no box',
  )
  const cpmGeom = await page2.locator('.cpm-menu .cpm-row').evaluateAll((rows) =>
    rows.slice(0, 7).map((row) => {
      const icon = row.querySelector('.app-icon')
      const label = row.querySelector('.cpm-row-label')
      const arrow = row.querySelector('.cpm-row-arrow')
      return {
        iconX: icon ? Math.round(icon.getBoundingClientRect().left) : null,
        iconW: icon ? Math.round(icon.getBoundingClientRect().width) : null,
        labelX: label ? Math.round(label.getBoundingClientRect().left) : null,
        arrowX: arrow ? Math.round(arrow.getBoundingClientRect().right) : null,
        h: Math.round(row.getBoundingClientRect().height),
        primary: row.classList.contains('primary'),
      }
    }),
  )
  assert(
    '+ 菜单：七行等高 46px',
    cpmGeom.every((r) => r.h === 46),
    JSON.stringify(cpmGeom.map((r) => r.h)),
  )
  assert(
    '+ 菜单：图标列 18px 且左缘严格成列',
    cpmGeom.every((r) => r.iconW === 18 && r.iconX === cpmGeom[0].iconX),
    JSON.stringify(cpmGeom.map((r) => [r.iconX, r.iconW])),
  )
  assert(
    '+ 菜单：标签左缘严格成列',
    cpmGeom.every((r) => r.labelX === cpmGeom[1].labelX),
    JSON.stringify(cpmGeom.map((r) => r.labelX)),
  )
  assert(
    '+ 菜单：箭头右缘严格成列',
    cpmGeom.slice(1).every((r) => r.arrowX === cpmGeom[1].arrowX),
    JSON.stringify(cpmGeom.map((r) => r.arrowX)),
  )
  assert('+ 菜单：首行「添加文件」主操作浅底', cpmGeom[0].primary === true)
  // 主列「角色」行必须回显当前角色：模式/专家都有值，角色曾经光秃秃只剩箭头。
  // 注意用 label 精确匹配——角色值本身可能含「专家」字样，hasText 会撞行。
  const roleRow = page2
    .locator('.cpm-col-main .cpm-row')
    .filter({ has: page2.locator('.cpm-row-label:text-is("角色")') })
  const roleValueInit = (await roleRow.locator('.cpm-row-value').innerText().catch(() => '')).trim()
  assert('+ 菜单：「角色」行回显当前角色名', roleValueInit === '通用助手', `"${roleValueInit}"`)
  // #93：引用文件双列面板——左列高亮、右列文件列表（stub 返回空 → 空态）。
  const fileRow = page2.locator('.cpm-col-main .cpm-row').filter({ has: page2.locator('.cpm-row-label:text-is("引用对话中的文件")') })
  await fileRow.click()
  await page2.waitForTimeout(250)
  assert('#93：引用文件二级面板双列并列', (await page2.locator('.cpm-col-main:visible').count()) === 1 && (await page2.locator('.cpm-col-fly:visible').count()) === 1, '')
  // flyout 模式没有返回头（标题只在 drill-in 渲染）：断左行高亮 + 右列出文件面板内容。
  assert('#93：引用文件行高亮 + 右列渲染', (await fileRow.evaluate((el) => el.classList.contains('on'))) && ((await page2.locator('.cpm-col-fly .cpm-empty').count()) + (await page2.locator('.cpm-col-fly .cpm-file').count())) > 0, '')
  assert('#93：文件列表面板有空态或文件行', (await page2.locator('.cpm-col-fly .cpm-empty').count()) + (await page2.locator('.cpm-col-fly .cpm-file').count()) > 0, '')
  await page2.locator('.cpm-back').click().catch(() => {})
  await page2.waitForTimeout(150)
  // 「模式」行曾经是提交上箭头的复用，语义错；换成滑杆图标后用 data-icon 锁死。
  const modeIcon = await page2
    .locator('.cpm-menu .cpm-row', { hasText: '模式' })
    .first()
    .locator('.app-icon')
    .first()
    .getAttribute('data-icon')
    .catch(() => '')
  assert('+ 菜单：「模式」用滑杆图标（不是提交箭头）', modeIcon === 'sliders', modeIcon)
  // 专家子菜单：搜索 + 名册（9c 建 1 位 + 9d 导入 3 位 = 4 位）+ 召唤更多底栏。
  await page2.locator('.cpm-menu .cpm-row', { hasText: '专家' }).click()
  await page2.waitForTimeout(400)
  // WorkBuddy flyout 形态：子面板在右侧并列弹出，主列常驻——不是整屏替换。
  const flyBox = await page2.locator('.cpm-menu').boundingBox()
  assert(
    '+ 菜单：flyout 态总宽（主 320 + 子 300 ≈626）',
    !!flyBox && Math.abs(flyBox.width - 626) <= 4,
    flyBox ? `${Math.round(flyBox.width)}` : 'no box',
  )
  assert(
    '+ 菜单：flyout 态主列仍可见（六行没有被替换）',
    (await page2.locator('.cpm-col-main .cpm-row:visible').count()) === 7,
  )
  assert('+ 菜单：flyout 态无返回头（drill-in 才有）', (await page2.locator('.cpm-col-fly .cpm-sub-head').count()) === 0)
  // 列级几何：主列 302 + 缝 6 + 子列 300 = 内容盒 608（border-box）。
  // 曾犯过主列写 304 而 JS 总宽忘算边框 2px——子列右缘被 overflow:hidden 裁掉。
  const flyEdge = await page2.locator('.cpm-menu').evaluate((el) => {
    const menu = el.getBoundingClientRect()
    const main = el.querySelector('.cpm-col-main')
    const fly = el.querySelector('.cpm-col-fly')
    const cs = getComputedStyle(el)
    const innerRight = menu.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight)
    return {
      mainW: Math.round(main.getBoundingClientRect().width),
      // 子列右缘与菜单内容盒右缘的缝隙：0 = 严丝合缝，>1 = 被裁
      slack: Math.round(innerRight - fly.getBoundingClientRect().right),
    }
  })
  assert('+ 菜单：flyout 主列宽 302（与 JS 常量含边框对齐）', flyEdge.mainW === 302, `mainW=${flyEdge.mainW}`)
  assert('+ 菜单：flyout 子列右缘贴内容盒不被裁', flyEdge.slack >= -1 && flyEdge.slack <= 1, `slack=${flyEdge.slack}px`)
  const epRows = page2.locator('.cpm-menu .cpm-expert')
  assert(
    '专家子菜单：搜索框 + 全量名册 + 召唤更多底栏',
    (await page2.locator('.cpm-menu .cpm-search').count()) === 1 &&
      (await epRows.count()) === 4 &&
      (await page2.locator('.cpm-menu .cpm-more').count()) === 1,
    `search=${await page2.locator('.cpm-menu .cpm-search').count()} rows=${await epRows.count()}`,
  )
  assert('专家子菜单：底栏文案「召唤更多专家」', (await page2.locator('.cpm-menu .cpm-more').innerText()).includes('召唤更多专家'))
  // 发布态真实差异：草稿标「草稿」且 aria-disabled、不可召唤；导入成品标「已发布」可选。
  const draftRows = page2.locator('.cpm-menu .cpm-expert.draft')
  const liveRows = page2.locator('.cpm-menu .cpm-expert:not(.draft)')
  assert('专家子菜单：草稿标灰且禁用（未发布不可召唤）',
    (await draftRows.count()) === 1 && (await draftRows.first().getAttribute('aria-disabled')) === 'true',
    `drafts=${await draftRows.count()}`)
  assert('专家子菜单：已发布专家标「已发布」且可召唤',
    (await liveRows.count()) === 3 && (await liveRows.first().innerText()).includes('已发布'),
    `live=${await liveRows.count()}`)
  await draftRows.first().dispatchEvent('click')
  await page2.waitForTimeout(150)
  assert('专家子菜单：点草稿不产生 chip（发布门禁生效）',
    (await page2.locator('.hero-input-wrap .cpm-chip').count()) === 0)
  // 召唤页签：个人专家与专家团同一入口；专家团空态明示，不能静默无内容。
  const tabs = page2.locator('.cpm-menu .cpm-tab')
  assert('召唤子菜单：专家 / 专家团双页签', (await tabs.count()) === 2, `tabs=${await tabs.count()}`)
  await tabs.nth(1).click()
  await page2.waitForTimeout(200)
  const teamRows = page2.locator('.cpm-menu .cpm-expert')
  const teamLabelText = await teamRows.first().innerText().catch(() => '')
  assert('专家团页签：列出可召唤团队', (await teamRows.count()) === 1 && teamLabelText.includes('前端专家团'), teamLabelText)
  // 团队是绑定选择（与专家同语义）：点选后以 chip 回显，绝不把 /team dispatch <id> 塞进输入框
  // （用户截图病灶：输入框出现一串内部 id）。
  await teamRows.first().click()
  await page2.waitForTimeout(250)
  assert('专家团：点选后菜单收起', (await page2.locator('.cpm-menu').count()) === 0)
  const teamChip = (await page2.locator('.hero-input-wrap .cpm-chip.team').first().innerText().catch(() => '')).trim()
  assert('专家团：选中以 chip 回显团名（不是内部 id）', teamChip.includes('前端专家团'), teamChip)
  // 团队 chip 必须与专家 chip 同一形态（同一选择语义）——先记下几何，等专家 chip 出现后比对。
  const chipGeom = (loc) =>
    loc.evaluate((el) => {
      const cs = getComputedStyle(el)
      const r = el.getBoundingClientRect()
      return {
        h: Math.round(r.height),
        radius: cs.borderRadius,
        fontSize: cs.fontSize,
        gap: cs.gap,
        padding: cs.padding,
        bg: cs.backgroundColor,
      }
    })
  const teamChipGeom = await chipGeom(page2.locator('.hero-input-wrap .cpm-chip.team').first())
  assert(
    '专家团：输入框保持干净（没有 /team dispatch 泄漏）',
    !(await page2.locator('.hero-input-wrap .app-textarea').first().inputValue()).includes('/team'),
  )
  // chip 移除键 = 解绑。
  await page2.locator('.hero-input-wrap .cpm-chip.team .cpm-chip-x').first().click()
  await page2.waitForTimeout(250)
  assert('专家团：chip 移除键解绑', (await page2.locator('.hero-input-wrap .cpm-chip.team').count()) === 0)
  // 召唤后菜单收起；重开一次验证页签仍独立（不残留上一次的团队视图）。
  await plusBtn.click()
  await page2.waitForTimeout(200)
  await page2.locator('.cpm-menu .cpm-row', { hasText: '专家' }).click()
  await page2.waitForTimeout(300)
  assert('召唤页签：重开后默认回到专家名册', (await page2.locator('.cpm-menu .cpm-expert').count()) === 4)
  // 列表区独立滚动、搜索固定：巨面板的结构性锁。
  const listScrolls = await page2.locator('.cpm-menu .cpm-list').evaluate((el) => {
    const cs = getComputedStyle(el)
    return cs.overflowY === 'auto' || cs.overflowY === 'scroll'
  }).catch(() => false)
  assert('专家子菜单：列表区独立滚动（搜索/底栏不跟着滚）', listScrolls, `overflowY=${listScrolls}`)
  // 单选语义：点一项 = 选中并收起菜单，chip 回显名字（状态只此一处）。
  const pureName = (loc) => loc.evaluate((el) => (el.firstChild?.textContent ?? '').trim())
  const firstName = await pureName(epRows.first().locator('.cpm-expert-name'))
  await epRows.first().click()
  await page2.waitForTimeout(250)
  assert('专家子菜单：点选后菜单收起', (await page2.locator('.cpm-menu').count()) === 0)
  const chipText = (await page2.locator('.hero-input-wrap .cpm-chip').first().innerText().catch(() => '')).trim()
  assert('首页：选中专家以 chip 回显', chipText.includes(firstName), `${chipText} vs ${firstName}`)
  // 团队 chip 与专家 chip 必须同形态（同一「绑定选择」语义的两枚徽章）：
  // 高度/圆角/字号/间距/底色逐项一致，用户才不会看出「一个是正式的一个是附带的」。
  const expertChipGeom = await chipGeom(page2.locator('.hero-input-wrap .cpm-chip').first())
  const chipSame = Object.keys(expertChipGeom).every(
    (k) => String(expertChipGeom[k]) === String(teamChipGeom[k]),
  )
  assert('专家团：chip 与专家 chip 同形态', chipSame, `${JSON.stringify(expertChipGeom)} vs ${JSON.stringify(teamChipGeom)}`)
  // chip 移除键 = 清除选择（不再需要「再点开选同一项取消」的隐藏交互）。
  await page2.locator('.hero-input-wrap .cpm-chip-x').first().click()
  await page2.waitForTimeout(250)
  assert('首页：chip 移除键清除专家选择', (await page2.locator('.hero-input-wrap .cpm-chip').count()) === 0)
  // 搜索过滤：关键字命中一位。
  await plusBtn.click()
  await page2.waitForTimeout(200)
  await page2.locator('.cpm-menu .cpm-row', { hasText: '专家' }).click()
  await page2.waitForTimeout(300)
  await page2.locator('.cpm-menu .cpm-search').fill('牵头人')
  await page2.waitForTimeout(250)
  assert('专家子菜单：搜索过滤名册', (await page2.locator('.cpm-menu .cpm-expert').count()) === 1, `rows=${await page2.locator('.cpm-menu .cpm-expert').count()}`)
  // 「召唤更多专家」跳能力中心专家 tab。
  await page2.locator('.cpm-menu .cpm-more').click()
  await page2.waitForTimeout(600)
  assert('专家子菜单：「召唤更多专家」跳能力中心', page2.url().includes('/capabilities') && page2.url().includes('tab=expert'), page2.url())
  await page2.goto(`http://localhost:${PORT}/#/chat`, { waitUntil: 'load' })
  await page2.waitForTimeout(700)
  // 模式行：三选一互斥，选中以 mode chip 回显；默认态不占 chip。
  await plusBtn.click()
  await page2.waitForTimeout(200)
  await page2.locator('.cpm-menu .cpm-row', { hasText: '模式' }).click()
  await page2.waitForTimeout(300)
  const modeRows = page2.locator('.cpm-col-fly .cpm-row')
  const modeNames = (await modeRows.locator('.cpm-row-label').allInnerTexts()).map((s) => s.trim())
  assert(
    '模式子菜单：默认/计划/仅问答 三选一',
    (await modeRows.count()) === 3 && modeNames.includes('默认（Agent）') && modeNames.includes('计划（Plan）') && modeNames.includes('仅问答（Ask）'),
    JSON.stringify(modeNames),
  )
  assert('模式子菜单：默认态选中（Agent 高亮）', (await page2.locator('.cpm-col-fly .cpm-row.on').count()) === 1)
  await page2.locator('.cpm-menu .cpm-row', { hasText: '计划' }).click()
  await page2.waitForTimeout(250)
  const modeChip = (await page2.locator('.hero-input-wrap .cpm-chip.mode').innerText().catch(() => '')).trim()
  assert('模式：选计划后 chip 回显', modeChip.includes('计划'), modeChip)
  await plusBtn.click()
  await page2.waitForTimeout(200)
  await page2.locator('.cpm-menu .cpm-row', { hasText: '模式' }).click()
  await page2.waitForTimeout(250)
  await page2.locator('.cpm-menu .cpm-row', { hasText: '默认' }).click()
  await page2.waitForTimeout(250)
  assert('模式：切回默认后 chip 消失', (await page2.locator('.hero-input-wrap .cpm-chip.mode').count()) === 0)
  // 技能行：点击把 /skill:<name> 插进草稿（内核斜杠命令通道，前端不自造第二套）。
  await plusBtn.click()
  await page2.waitForTimeout(200)
  await page2.locator('.cpm-menu .cpm-row', { hasText: '技能' }).click()
  await page2.waitForTimeout(300)
  const skillRows = page2.locator('.cpm-col-fly .cpm-row')
  assert('技能子菜单：列出 skills_list 全部技能', (await skillRows.count()) === 2, `rows=${await skillRows.count()}`)
  await page2.locator('.cpm-menu .cpm-row', { hasText: 'pdf' }).click()
  await page2.waitForTimeout(250)
  const heroDraft = await page2.locator('.hero-input-wrap .app-textarea').first().inputValue()
  assert('技能：点击把 /skill:pdf 插进草稿', heroDraft.includes('/skill:pdf'), heroDraft)
  await page2.locator('.hero-input-wrap .app-textarea').first().fill('')
  // 连接器行：勾选走 set_selection + apply_scope 真实链路。
  await plusBtn.click()
  await page2.waitForTimeout(200)
  await page2.locator('.cpm-menu .cpm-row', { hasText: '连接器' }).click()
  await page2.waitForTimeout(300)
  const connRows = page2.locator('.cpm-menu .cpm-conn')
  assert('连接器子菜单：列出已导入连接器', (await connRows.count()) === 2, `rows=${await connRows.count()}`)
  // 原生 input 被视觉盒盖住（无障碍惯例）：点 label 容器触发勾选。
  await connRows.first().locator('.app-check').click()
  await page2.waitForTimeout(300)
  const connSel = await page2.evaluate(() => window.__PI_STUB__.connSel ?? [])
  assert('连接器：勾选落 set_selection', connSel.length === 1, JSON.stringify(connSel))
  // Esc 分层：子面板态第一次回根菜单，第二次才关菜单。
  await page2.keyboard.press('Escape')
  await page2.waitForTimeout(200)
  assert('Esc 第一次：连接器子面板退回根菜单', (await page2.locator('.cpm-menu').count()) === 1)
  await page2.keyboard.press('Escape')
  await page2.waitForTimeout(200)
  assert('Esc 第二次：菜单收起', (await page2.locator('.cpm-menu').count()) === 0)
  await page2.screenshot({ path: path.join(OUT, '42-hero-plus-menu.png'), animations: 'disabled' })
  // 窄屏回落：视口放不下两列（<760）时菜单转 drill-in——子列独占、返回头出现、
  // 主列隐藏，且整卡不出视口。WorkBuddy 在手机上也是这个形态。
  await page2.setViewportSize({ width: 390, height: 844 })
  await page2.waitForTimeout(400)
  await plusBtn.click()
  await page2.waitForTimeout(300)
  await page2.locator('.cpm-menu .cpm-row', { hasText: '专家' }).click()
  await page2.waitForTimeout(500)
  const drillGeom = await page2.locator('.cpm-menu').evaluate((el) => {
    const menu = el.getBoundingClientRect()
    const main = el.querySelector('.cpm-col-main')
    return {
      w: Math.round(menu.width),
      inViewport: menu.left >= 0 && menu.right <= window.innerWidth,
      mainHidden: !main || getComputedStyle(main).display === 'none',
      drill: el.classList.contains('is-drill'),
      backHead: !!el.querySelector('.cpm-col-fly .cpm-sub-head'),
      backTitle: el.querySelector('.cpm-sub-title')?.textContent?.trim() ?? '',
    }
  })
  assert('窄屏 390：菜单转 drill-in 且整卡在视口内', drillGeom.inViewport && drillGeom.drill, JSON.stringify(drillGeom))
  assert('窄屏 390：drill-in 态主列隐藏、返回头出现', drillGeom.mainHidden && drillGeom.backHead && drillGeom.backTitle === '专家', JSON.stringify(drillGeom))
  assert('窄屏 390：drill-in 宽度回落 320（不再撑 626）', Math.abs(drillGeom.w - 320) <= 2, `w=${drillGeom.w}`)
  await page2.locator('.cpm-back').click()
  await page2.waitForTimeout(300)
  const backRoot = await page2.locator('.cpm-menu').evaluate((el) => ({
    drill: el.classList.contains('is-drill'),
    mainVisible: getComputedStyle(el.querySelector('.cpm-col-main')).display !== 'none',
  }))
  assert('窄屏 390：返回键退回根菜单', !backRoot.drill && backRoot.mainVisible, JSON.stringify(backRoot))
  await page2.screenshot({ path: path.join(OUT, '42b-plus-menu-drill-390.png'), animations: 'disabled' })
  await page2.keyboard.press('Escape')
  await page2.waitForTimeout(200)
  await page2.setViewportSize({ width: 1440, height: 900 })
  await page2.waitForTimeout(300)
  // 输入框宽度：hero 用独立的 --hero-col（≤720），不跟消息列铺满（用户「输入框太宽」）。
  const heroCardBox = await page2.locator('.hero-card').first().boundingBox()
  assert(
    '首页：hero 卡片收窄在 760px 以内',
    !!heroCardBox && heroCardBox.width <= 760,
    heroCardBox ? `${Math.round(heroCardBox.width)}px` : 'no box',
  )

  // ── 9f. 选定专家后的运行流程（用户「把每个专家选择后的流程全部都跑一次」）──
  // 选上只是半条命：另半条是「发送真的带上了专家身份」。pi_send 命令里必须有
  // expertId——桥据此 load_expert → write_expert_policy（工具门+MCP 名单）→
  // persona 注入 → expert_start 落链路。任何一环断了，专家就是摆设。
  // hero 与会话态 composer 是两处挂载点，各跑一遍「选 → 发 → 透传」。
  const lastExpertSend = (p) =>
    p.evaluate(() => {
      const sends = (window.__PI_STUB__?.argCalls ?? []).filter((c) => c.cmd === 'pi_send')
      for (let i = sends.length - 1; i >= 0; i--) {
        try {
          const req = JSON.parse(sends[i].args.json)
          if (req.expertId) return req
        } catch {}
      }
      return null
    })
  const waitForExpertSend = (p, id) =>
    p
      .waitForFunction(
        (want) =>
          (window.__PI_STUB__?.argCalls ?? []).some((c) => {
            if (c.cmd !== 'pi_send') return false
            try {
              return JSON.parse(c.args.json).expertId === want
            } catch {
              return false
            }
          }),
        id,
        { timeout: 8000 },
      )
      .catch(() => {})
  // 通过 + 菜单选专家的小流程（hero 挂载点）。
  const heroPickExpert = async (name) => {
    await page2.locator('.hero-input-wrap .cpm-trigger').click()
    await page2.waitForTimeout(200)
    await page2.locator('.cpm-menu .cpm-row', { hasText: '专家' }).click()
    await page2.waitForTimeout(300)
    await page2.locator('.cpm-menu .cpm-expert').filter({ hasText: name }).first().click()
    await page2.waitForTimeout(250)
  }

  // hero 路径：选「独立评审员」→ 打字 → 发送 → pi_send 必须带 expertId。
  await heroPickExpert('独立评审员')
  const heroChip = (await page2.locator('.hero-input-wrap .cpm-chip').first().innerText().catch(() => '')).trim()
  assert('首页：chip 回显所选专家名', heroChip.includes('独立评审员'), heroChip)
  await page2.locator('.hero-input-wrap .app-textarea').first().fill('用独立评审员看一眼改动')
  await page2.locator('.hero-send').click()
  await waitForExpertSend(page2, 'solo-reviewer')
  const heroSendReq = await lastExpertSend(page2)
  assert(
    '首页：选定专家后发送，pi_send 带 expertId（桥据此落策略/persona）',
    !!heroSendReq &&
      heroSendReq.expertId === 'solo-reviewer' &&
      heroSendReq.type === 'prompt' &&
      String(heroSendReq.message).includes('用独立评审员看一眼改动'),
    JSON.stringify(heroSendReq ?? null).slice(0, 180),
  )
  // 专家是一次性选择：发出后离开落地页，chip 随 hero 消费掉（下一条普通消息不继承）。
  await page2.waitForTimeout(700)
  assert('首页：专家消息发出后进入会话流', (await page2.locator('.chat-hero').count()) === 0)
  // 非 scripted 桩不自动收尾：不收这轮，会话态第二条会进 follow_up 队列而不是新派发。
  await page2.evaluate(() => window.__PI_STUB__.emitSettled())
  await page2.waitForTimeout(300)

  // 会话态路径：composer 工具条上的同一个 + 菜单，换一位专家再跑一遍。
  const sessPlus = page2.locator('.composer .cpm-trigger')
  assert('会话态：输入框工具条同样挂着 + 召唤菜单', (await sessPlus.count()) === 1, `count=${await sessPlus.count()}`)
  assert('会话态：发出后 chip 保留（专家持续生效，WorkBuddy 语义）', (await page2.locator('.composer .cpm-chip').first().innerText().catch(() => '')).includes('独立评审员'))
  await sessPlus.click()
  await page2.waitForTimeout(200)
  await page2.locator('.cpm-menu .cpm-row', { hasText: '专家' }).click()
  await page2.waitForTimeout(300)
  await page2.locator('.cpm-menu .cpm-expert').filter({ hasText: '团队牵头人' }).first().click()
  await page2.waitForTimeout(250)
  const sessChip = (await page2.locator('.composer .cpm-chip').first().innerText().catch(() => '')).trim()
  assert('会话态：chip 回显所选专家名', sessChip.includes('团队牵头人'), sessChip)
  await page2.locator('.composer .app-textarea').first().fill('让牵头人排一下验收顺序')
  await page2.locator('.composer .send').click()
  await waitForExpertSend(page2, 'code-crew-team-lead')
  const sessSendReq = await lastExpertSend(page2)
  assert(
    '会话态：选定专家后发送同样带 expertId',
    !!sessSendReq &&
      sessSendReq.expertId === 'code-crew-team-lead' &&
      String(sessSendReq.message).includes('让牵头人排一下验收顺序'),
    JSON.stringify(sessSendReq ?? null).slice(0, 180),
  )
  // 持续生效：换专家后 chip 跟着换；用户不点移除键就不会消失。
  await page2.waitForTimeout(500)
  assert('会话态：换专家后 chip 保持新身份', (await page2.locator('.composer .cpm-chip').first().innerText().catch(() => '')).includes('团队牵头人'))
  await page2.evaluate(() => window.__PI_STUB__.emitSettled())
  await page2.waitForTimeout(200)

  // ── 9f2. 引用体系（#65）：assistant 选区 → 浮层 → 托盘 → 下发 → 气泡回显 ──
  // 选区引用是 WorkBuddy「添加到对话」的核心通路：摘一段回复、带批注、随下一条
  // 消息下发。Pi 侧走独立 [引用 / quotes] 块 + 独立富字段，不污染附件通道。
  // 非 scripted 桩不自回：手工灌一轮 assistant 回复，才有可选中的正文（形状照 replyScripted）。
  await page2.evaluate(() => {
    const emit = (rec) => window.__PI_STUB__.emitPi(rec)
    const runId = 'run-quote'
    const t0 = Date.now()
    const usage = { input: 120, output: 42, cacheRead: 0, cacheWrite: 0, totalTokens: 162, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
    emit({ type: 'message_start', message: { role: 'assistant', content: [] }, runId, agentId: 'main', pi_ts: t0 })
    emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '收到，已处理。' }, usage, runId, agentId: 'main', pi_ts: t0 + 10 })
    emit({ type: 'message_end', message: { role: 'assistant', content: [], usage }, runId, agentId: 'main', pi_ts: t0 + 60 })
    emit({ type: 'agent_settled', runId, runStatus: 'ok', pi_ts: t0 + 62 })
  })
  await page2.waitForTimeout(300)
  const lastPiSendArg = (p, want) =>
    p.evaluate((w) => {
      const calls = (window.__PI_STUB__?.argCalls ?? []).filter((c) => c.cmd === 'pi_send')
      for (let i = calls.length - 1; i >= 0; i--) {
        try {
          const j = JSON.parse(calls[i].args.json)
          if (!w || String(j.message ?? '').includes(w)) return j
        } catch {}
      }
      return null
    }, want)
  // Range 选中 .md 里的目标子串（v-html 节点 Vue 管不到，只能 DOM 直选）。
  const selectIn = (p, loc, sub) =>
    loc.evaluate((el, s) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      let n
      while ((n = walker.nextNode())) {
        const i = n.data.indexOf(s)
        if (i < 0) continue
        const r = document.createRange()
        r.setStart(n, i)
        r.setEnd(n, i + s.length)
        const sel = window.getSelection()
        sel.removeAllRanges()
        sel.addRange(r)
        n.parentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
        return true
      }
      return false
    }, sub)

  // 负例：用户气泡的选区不弹浮层（引用自己的话没有意义，只允许引用回复）。
  const userTxt = page2.locator('.msgs .msg-row.user .txt').last()
  assert('引用：能在会话里找到用户气泡', (await userTxt.count()) === 1, `count=${await userTxt.count()}`)
  await selectIn(page2, userTxt, '让牵头人排一下验收顺序')
  await page2.waitForTimeout(150)
  assert('引用：用户气泡选区不弹「添加到对话」', (await page2.locator('.sel-pop').count()) === 0)

  // 正例：assistant 正文选区 → 浮层出现，带批注框与「添加到对话」。
  const mdLast = page2.locator('.msgs .msg-row.assistant .md').last()
  assert('引用：能在会话里找到 assistant 正文', (await mdLast.count()) === 1 && (await mdLast.innerText()).includes('已处理'), `text=${(await mdLast.innerText().catch(() => '')).slice(0, 30)}`)
  await selectIn(page2, mdLast, '已处理')
  await page2.waitForTimeout(200)
  const pop = page2.locator('.sel-pop')
  assert('引用：assistant 选区浮出「添加到对话」浮层', (await pop.count()) === 1, `count=${await pop.count()}`)
  const popInView = await pop.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1
  }).catch(() => false)
  assert('引用：浮层完整落在视口内', popInView === true, '浮层越界')
  assert('引用：浮层来源提示带原文开头', (await pop.locator('.sel-pop-src').innerText()).includes('引用：收到'))

  // 批注框 → 添加 → 托盘 chip（可移除态），批注单独一行。
  // AppInput 的根节点就是 <input>，class 透传落在 input 本体上（没有内层 input）。
  await pop.locator('.sel-pop-note').fill('重点看这里')
  await pop.locator('.sel-pop-add').click()
  await page2.waitForTimeout(150)
  assert('引用：添加后浮层收起', (await page2.locator('.sel-pop').count()) === 0)
  const qChip = page2.locator('.composer .quote-tray .quote-chip')
  assert('引用：托盘出现引用卡', (await qChip.count()) === 1, `count=${await qChip.count()}`)
  assert('引用：卡内显示原文截断', (await qChip.locator('.quote-text').innerText()).trim() === '已处理')
  assert('引用：卡内显示批注', (await qChip.locator('.quote-note').innerText()).includes('重点看这里'))
  assert('引用：卡 title 带完整原文', (await qChip.getAttribute('title')) === '已处理')
  const qChipW = await qChip.evaluate((el) => Math.round(el.getBoundingClientRect().width))
  assert('引用：卡宽不超 320', qChipW <= 320, `w=${qChipW}`)

  // 空草稿 + 有引用：发送键可用（「只发引用」合法）。
  assert('引用：空草稿但有引用时发送键可用', (await page2.locator('.composer .send').isDisabled()) === false)

  // 发送：pi_send 必须带 [引用 / quotes] 块 + quotes 富字段（回放还原靠它）。
  await page2.locator('.composer .send').click()
  await page2.waitForTimeout(400)
  const quoteReq = await lastPiSendArg(page2, '[引用 / quotes]')
  assert(
    '引用：下发带引用块与富字段',
    !!quoteReq &&
      Array.isArray(quoteReq.quotes) &&
      quoteReq.quotes.length === 1 &&
      quoteReq.quotes[0].kind === 'text' &&
      quoteReq.quotes[0].text === '已处理' &&
      quoteReq.quotes[0].note === '重点看这里' &&
      String(quoteReq.message).includes('- [1] 已处理') &&
      String(quoteReq.message).includes('批注: 重点看这里'),
    JSON.stringify(quoteReq ?? null).slice(0, 220),
  )
  // 内核回显前 pushUser 已落气泡：引用卡应出现在 user 行（历史记录，无移除键）。
  const sentChip = page2.locator('.msgs .msg-row.user .sent-quotes .quote-chip')
  assert('引用：气泡回显引用卡', (await sentChip.count()) === 1, `count=${await sentChip.count()}`)
  assert('引用：气泡引用卡无移除键（历史记录不可删）', (await sentChip.locator('.quote-x').count()) === 0)
  // 空正文 + 有引用：不许渲染空气泡（截图核查抓出的 artifact——引用卡上方一个白 pill）。
  const sentRow = page2.locator('.msgs .msg-row.user').filter({ has: page2.locator('.sent-quotes') }).last()
  assert('引用：只发引用时不出现空正文气泡', (await sentRow.locator('.txt').count()) === 0, `txt=${await sentRow.locator('.txt').count()}`)
  await page2.evaluate(() => window.__PI_STUB__.emitSettled())
  await page2.waitForTimeout(300)
  await page2.screenshot({ path: path.join(OUT, '43-quote-flow.png') })

  // ── 9f3. M10 拖拽上传（#66）：窗口级 drag-* 事件 → 遮罩 → 松手落托盘 ──
  // 真实链路：Tauri 原生通道给绝对路径，前端复用 attachment_add 落盘副本。
  // 粘贴字节（剪贴板二进制无路径）属 #69 的 Rust attachment_add_bytes，不在此列。
  await page2.evaluate(() => window.__PI_STUB__.emitTauri('tauri://drag-enter', { paths: [], position: { x: 100, y: 100 } }))
  await page2.waitForTimeout(120)
  const veil = page2.locator('.drop-veil')
  assert('拖拽：enter 后遮罩出现', (await veil.count()) === 1, `count=${await veil.count()}`)
  assert('拖拽：遮罩带可落提示', (await veil.innerText()).includes('松开鼠标'))
  const veilBox = await veil.boundingBox()
  assert(
    '拖拽：遮罩覆盖对话区（inset 8px 不贴边）',
    veilBox !== null && veilBox.width > 800 && veilBox.height > 500,
    veilBox ? `${Math.round(veilBox.width)}x${Math.round(veilBox.height)}` : 'null',
  )
  await page2.evaluate(() => window.__PI_STUB__.emitTauri('tauri://drag-leave', null))
  await page2.waitForTimeout(120)
  assert('拖拽：leave 后遮罩收起', (await page2.locator('.drop-veil').count()) === 0)
  // 松手落两个文件：一张图 + 一个文档，托盘应并列两张卡。
  await page2.evaluate(() =>
    window.__PI_STUB__.emitTauri('tauri://drag-drop', {
      paths: ['/tmp/demo-shot.png', '/tmp/demo-spec.md'],
      position: { x: 200, y: 200 },
    }),
  )
  await page2.waitForTimeout(400)
  const dropChips = page2.locator('.composer .att-tray .att-chip')
  assert('拖拽：drop 后托盘出现两张附件卡', (await dropChips.count()) === 2, `count=${await dropChips.count()}`)
  assert('拖拽：drop 后遮罩收起', (await page2.locator('.drop-veil').count()) === 0)
  const dropNames = await page2.locator('.composer .att-tray .att-name').allInnerTexts()
  assert(
    '拖拽：托盘回显文件名',
    dropNames.includes('demo-shot.png') && dropNames.includes('demo-spec.md'),
    dropNames.join(','),
  )
  assert(
    '拖拽：图片走 image 卡（缩略图）、文档走 file 卡（图标）',
    (await page2.locator('.composer .att-chip.image .att-thumb').count()) === 1 &&
      (await page2.locator('.composer .att-chip.file > .app-icon').count()) === 1,
)
  const dropAdds = await page2.evaluate(() =>
    (window.__PI_STUB__?.argCalls ?? []).filter((c) => c.cmd === 'attachment_add').map((c) => c.args.src),
  )
  assert(
    '拖拽：每个路径都走 attachment_add（复用选文件同一落盘通道）',
    dropAdds.includes('/tmp/demo-shot.png') && dropAdds.includes('/tmp/demo-spec.md'),
    JSON.stringify(dropAdds).slice(0, 160),
  )
  assert('拖拽：空草稿 + 拖入附件时发送键可用', (await page2.locator('.composer .send').isDisabled()) === false)
  await page2.screenshot({ path: path.join(OUT, '44-drag-drop.png') })
  // 清场：别让拖进来的附件污染后面的连接器导入段。
  await page2.evaluate(() => {
    document.querySelectorAll('.composer .att-chip .att-x').forEach((b) => b.click())
  })
  await page2.waitForTimeout(200)
  assert('拖拽：移除键清空托盘', (await page2.locator('.composer .att-tray .att-chip').count()) === 0)

  // ── 9f4. M9 Widget 操作（#66）：产物卡 hover 引用 → 预览/代码切换 → 复制/保存 ──
  // 真实链路：artifacts_scan 从会话文本抽产物路径 → 卡片 → 点卡开预览 → 工具条动作。
  // 剪贴板走 Chromium 授权；保存走 plugin:dialog|save → artifact_save_as。
  await page2.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {})
  await page2.evaluate(() => {
    const emit = (rec) => window.__PI_STUB__.emitPi(rec)
    const runId = 'run-widget'
    const t0 = Date.now()
    const usage = { input: 120, output: 42, cacheRead: 0, cacheWrite: 0, totalTokens: 162, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
    emit({ type: 'message_start', message: { role: 'assistant', content: [] }, runId, agentId: 'main', pi_ts: t0 })
    emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: '看板做好了：/tmp/demo-widget.html，配图 /tmp/demo-shot.png。' },
      usage, runId, agentId: 'main', pi_ts: t0 + 10,
    })
    emit({ type: 'message_end', message: { role: 'assistant', content: [], usage }, runId, agentId: 'main', pi_ts: t0 + 60 })
    emit({ type: 'agent_settled', runId, runStatus: 'ok', pi_ts: t0 + 62 })
  })
  // 扫描有 500ms 防抖：等 byMessage 落卡。
  await page2.waitForTimeout(1400)
  const acards = page2.locator('.msgs .acstrip .acard')
  assert('Widget：会话文本里的产物路径长出卡片', (await acards.count()) === 2, `count=${await acards.count()}`)
  const acNames = (await page2.locator('.msgs .acstrip .acard .name').allInnerTexts()).join(',')
  assert('Widget：卡名回显文件名', acNames.includes('demo-widget.html') && acNames.includes('demo-shot.png'), acNames)
  // hover 才浮现「添加到对话」快捷键（触屏态常驻，Chromium headless 走 hover:hover）。
  const htmlCard = page2.locator('.msgs .acstrip .acard-wrap').filter({ hasText: 'demo-widget.html' })
  await htmlCard.hover()
  await page2.waitForTimeout(150)
  const actBtn = htmlCard.locator('.acard-acts .acard-act')
  assert('Widget：hover 产物卡浮现引用键', (await actBtn.count()) === 1 && (await actBtn.isVisible()) === true)
  await actBtn.click()
  await page2.waitForTimeout(200)
  const wChip = page2.locator('.composer .quote-tray .quote-chip')
  assert('Widget：hover 引用落托盘', (await wChip.count()) === 1, `count=${await wChip.count()}`)
  // widget 引用显文件名而非整条绝对路径（完整路径在 title）。
  assert('Widget：托盘引用显产物名', (await wChip.locator('.quote-text').innerText()).trim() === 'demo-widget.html')
  assert('Widget：引用 title 带完整路径', (await wChip.getAttribute('title')) === '/tmp/demo-widget.html')
  // 移除引用，再开预览走工具条。
  await wChip.locator('.quote-x').click()
  await page2.waitForTimeout(150)
  await htmlCard.locator('.acard').click()
  await page2.waitForTimeout(500)
  const modal = page2.locator('.modal-panel')
  assert('Widget：点卡打开预览层', (await modal.count()) === 1)
  // html 走 iframe 沙箱渲染，源码切换键应出现。
  assert('Widget：html 预览走 sandbox iframe', (await modal.locator('iframe.frame[sandbox=""]').count()) === 1)
  const seg = modal.locator('.ap-seg .ap-seg-btn')
  assert('Widget：文本类产物挂预览/代码切换（两键）', (await seg.count()) === 2, `count=${await seg.count()}`)
  await seg.nth(1).click()
  await page2.waitForTimeout(200)
  const codeEl = modal.locator('.ap-code')
  assert('Widget：切代码视图显示源码原文', (await codeEl.count()) === 1 && (await codeEl.innerText()).includes('demo widget'))
  assert('Widget：代码视图下 iframe 收起', (await modal.locator('iframe.frame').count()) === 0)
  await seg.nth(0).click()
  await page2.waitForTimeout(200)
  assert('Widget：切回预览 iframe 再现', (await modal.locator('iframe.frame').count()) === 1)
  // 「复制代码」：剪贴板应拿到源码全文。
  await modal.locator('.ap-act', { hasText: '复制' }).click()
  await page2.waitForTimeout(300)
  const clip = await page2.evaluate(() => navigator.clipboard.readText().catch(() => ''))
  assert('Widget：复制代码写入剪贴板', clip.includes('demo widget'), clip.slice(0, 60))
  assert('Widget：复制后按钮回显「已复制」', (await modal.locator('.ap-act', { hasText: '已复制' }).count()) === 1)
  // 「引用」键（预览层通路）：同样落托盘。
  await modal.locator('.ap-act', { hasText: '引用' }).click()
  await page2.waitForTimeout(200)
  assert('Widget：预览层引用键落托盘', (await page2.locator('.composer .quote-tray .quote-chip').count()) === 1)
  assert('Widget：预览层引用键回显「已添加」', (await modal.locator('.ap-act', { hasText: '已添加' }).count()) === 1)
  await page2.screenshot({ path: path.join(OUT, '45-widget-preview.png'), animations: 'disabled' })
  // 「保存」：dialog|save 给去向 → artifact_save_as 落盘调用。
  await modal.locator('.ap-act', { hasText: '保存' }).click()
  await page2.waitForTimeout(400)
  const savedCall = await page2.evaluate(() => window.__PI_STUB__?.saved ?? null)
  assert(
    'Widget：保存走 dialog→artifact_save_as（src=产物, dest=对话框去向）',
    !!savedCall && savedCall.src === '/tmp/demo-widget.html' && String(savedCall.dest).includes('demo-widget.html'),
    JSON.stringify(savedCall ?? null),
  )
  await page2.keyboard.press('Escape')
  await page2.waitForTimeout(300)
  assert('Widget：Esc 关预览层', (await page2.locator('.modal-panel').count()) === 0)
  // 图片产物：无源码切换（字节流没有代码可言），但有「复制图片」与保存。
  const imgCard = page2.locator('.msgs .acstrip .acard-wrap').filter({ hasText: 'demo-shot.png' })
  await imgCard.locator('.acard').click()
  await page2.waitForTimeout(500)
  assert('Widget：图片预览不挂代码切换', (await page2.locator('.modal-panel .ap-seg').count()) === 0)
  assert('Widget：图片预览走 <img> 且给 data URL', (await page2.locator('.modal-panel img.img[src^="data:image/"]').count()) === 1)
  assert('Widget：图片预览有「复制图片」键', (await page2.locator('.modal-panel .ap-act', { hasText: '复制' }).count()) === 1)
  await page2.locator('.modal-panel .ap-act', { hasText: '保存' }).click()
  await page2.waitForTimeout(300)
  const savedImg = await page2.evaluate(() => window.__PI_STUB__?.saved ?? null)
  assert('Widget：图片同样走 artifact_save_as 保存', !!savedImg && savedImg.src === '/tmp/demo-shot.png', JSON.stringify(savedImg ?? null))
  await page2.keyboard.press('Escape')
  await page2.waitForTimeout(200)
  // 清场：引用托盘残留会污染下一段；产物卡由会话数据驱动，无需清。
  await page2.evaluate(() => {
    document.querySelectorAll('.composer .quote-chip .quote-x').forEach((b) => b.click())
  })
  await page2.waitForTimeout(150)

  // ── 9f5. M8 MCP 加载进度（#66）：握手态驱动的对话流临时条 ──
  // 真实链路：后端启动 restore() 逐个同步握手，connectors_list 暴露 discovering/ready/offline；
  // 前端轮询收敛。stub 用 __PI_SEED_CONNS__ 在 app 启动前种状态：前 N 次回 discovering，
  // 之后收敛 settled——断言「正在连接 → 已就绪 → 自毁」完整时间线。
  // 另开一页验证失败分支：有 offline 项时汇总条不自动消失。
  const pageMcp = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  pageMcp.on('pageerror', (e) => flowErrors.push(e.message))
  await pageMcp.addInitScript(`window.__PI_REPLAY_MODE__ = true; window.__PI_REPLAY_ACTIVE__ = true; window.__PI_SEED_CONNS__ = { states: {}, pending: 2 }`)
  await pageMcp.addInitScript(PI_STUB_SCRIPT)
  await pageMcp.goto(`http://localhost:${PORT}/#/chat`, { waitUntil: 'load' })
  const strip = pageMcp.locator('.mcp-strip')
  await strip.waitFor({ state: 'visible', timeout: 8000 })
  assert('MCP进度：握手期出现临时条', (await strip.count()) === 1)
  const connText = await strip.locator('.mcp-text').innerText()
  assert('MCP进度：连接态文案「正在连接 N/总数 · 握手中 M」', connText.includes('正在连接 MCP 服务 0/2') && connText.includes('握手中 2'), connText)
  // 默认收起，点开展开分组：未连组列出两位。
  assert('MCP进度：分组默认收起', (await strip.locator('.mcp-groups').count()) === 0)
  await strip.locator('.mcp-head').click()
  await pageMcp.waitForTimeout(150)
  const pendItems = strip.locator('.mcp-group.pend .mcp-item')
  assert('MCP进度：展开后未连分组列出握手中的服务', (await pendItems.count()) === 2, `count=${await pendItems.count()}`)
  const pendNames = (await pendItems.allInnerTexts()).join(',')
  assert('MCP进度：未连分组回显连接器名', pendNames.includes('GitHub') && pendNames.includes('Notion'), pendNames)
  // 收敛：settled 全 ready → 成功条「所有 MCP 服务已就绪」
  await pageMcp.waitForSelector('.mcp-strip.done', { timeout: 8000 })
  const doneText = await pageMcp.locator('.mcp-strip.done .mcp-text').innerText()
  assert('MCP进度：全就绪显示「所有 MCP 服务已就绪」', doneText.includes('所有 MCP 服务已就绪'), doneText)
  await pageMcp.screenshot({ path: path.join(OUT, '46-mcp-ready.png'), animations: 'disabled' })
  // 临时条自毁：就绪态驻留约 3s 后消失，且不落进消息历史。
  await pageMcp.waitForSelector('.mcp-strip', { state: 'detached', timeout: 8000 })
  assert('MCP进度：就绪后临时条自动消失（不落历史）', (await pageMcp.locator('.mcp-strip').count()) === 0)
  assert('MCP进度：临时条不在消息流内部', (await pageMcp.locator('.msgs .mcp-strip').count()) === 0)
  await pageMcp.close()
  // 失败分支：有 offline 项 → 汇总条「已连 N，异常 M」且不自动消失（需要用户处理）。
  const pageMcpBad = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  pageMcpBad.on('pageerror', (e) => flowErrors.push(e.message))
  await pageMcpBad.addInitScript(`window.__PI_REPLAY_MODE__ = true; window.__PI_REPLAY_ACTIVE__ = true; window.__PI_SEED_CONNS__ = { states: { 'c-github': 'offline' }, pending: 1 }`)
  await pageMcpBad.addInitScript(PI_STUB_SCRIPT)
  await pageMcpBad.goto(`http://localhost:${PORT}/#/chat`, { waitUntil: 'load' })
  await pageMcpBad.waitForSelector('.mcp-strip.failed', { timeout: 8000 })
  const failText = await pageMcpBad.locator('.mcp-strip.failed .mcp-text').innerText()
  assert('MCP进度：有异常项显示「已连 N，异常 M」汇总', failText.includes('已连 1') && failText.includes('异常 1'), failText)
  await pageMcpBad.locator('.mcp-strip.failed .mcp-head').click()
  await pageMcpBad.waitForTimeout(150)
  assert('MCP进度：失败态展开列出已连与异常两组', (await pageMcpBad.locator('.mcp-group.ok').count()) === 1 && (await pageMcpBad.locator('.mcp-group.bad').count()) === 1)
  await pageMcpBad.waitForTimeout(3600)
  assert('MCP进度：失败汇总不自动消失（需用户处理）', (await pageMcpBad.locator('.mcp-strip.failed').count()) === 1)
  await pageMcpBad.screenshot({ path: path.join(OUT, '47-mcp-failed.png'), animations: 'disabled' })
  await pageMcpBad.close()

  // ── 9g. 连接器导入源（Cordis 思想：适配器只归一化，导入恒走 connectors_create 主路径）──
  // 用户原话「把其他的到时插件（接口，抽象化）这种接入进来」：WorkBuddy 的
  // ~/.workbuddy/mcp.json（mcpServers 字典，带 type/url/disabled）形状与本地
  // 完全不同，后端 parse_workbuddy_mcp 归一成规范候选，前端逐项走手工新建
  // 同一条域路径——校验/唯一性/握手零旁路。断言三件事：坏项被挡在门外、
  // 好项归一正确、落库调用与 connectorsCreate 入参完全同构。
  await page2.goto(`http://localhost:${PORT}/#/capabilities?tab=connector`, { waitUntil: 'load' })
  await page2.waitForTimeout(600)
  const importBtn = page2.locator('.cp-toolbar .app-btn', { hasText: '从 WorkBuddy 导入' })
  assert('连接器导入：工具条挂「从 WorkBuddy 导入」', (await importBtn.count()) === 1, `count=${await importBtn.count()}`)
  await importBtn.click()
  await page2.waitForTimeout(600)
  const ciItems = page2.locator('.modal-panel .ci-item')
  assert('连接器导入：弹窗列出全部候选（含不可导入项）', (await ciItems.count()) === 4, `items=${await ciItems.count()}`)
  const ciRoot = (await page2.locator('.modal-panel .ci-root code').innerText().catch(() => '')).trim()
  assert('连接器导入：显示源路径（~ 缩写）', ciRoot === '~/.workbuddy/mcp.json', ciRoot)
  // 不可导入的两项：缺命令 + 与本地重名冲突——置灰、无勾选框、给人话原因。
  const ciOff = await page2.locator('.modal-panel .ci-item.off').count()
  const ciOffText = (await page2.locator('.modal-panel .ci-item.off').allInnerTexts()).join(' | ')
  assert(
    '连接器导入：缺命令/重名冲突项置灰并说明原因',
    ciOff === 2 && ciOffText.includes('缺少启动命令') && ciOffText.includes('不能重复导入'),
    ciOffText.slice(0, 160),
  )
  // 源侧停用的可导入项要带徽标（disabled:true → 「源侧已停用」），但仍可勾。
  const ciOffBadge = (await page2.locator('.modal-panel .ci-src-off').allInnerTexts()).join(',')
  assert('连接器导入：源侧停用项显示徽标但不阻止导入', ciOffBadge.includes('源侧已停用'), ciOffBadge)
  // 默认全选可导入项 = 2 个勾选框。
  const ciChecks = page2.locator('.modal-panel .ci-item .app-check')
  assert('连接器导入：可导入项默认全选（2 个勾选框）', (await ciChecks.count()) === 2, `checks=${await ciChecks.count()}`)
  await page2.screenshot({ path: path.join(OUT, '43-connector-import.png'), animations: 'disabled' })
  await page2.locator('.modal-footer .app-btn', { hasText: '导入所选' }).click()
  await page2.waitForTimeout(800)
  // 逐项走 connectors_create：入参与手工新建完全同构（规范 ConnectorInput，凭据空）。
  const connCreates = await page2.evaluate(() =>
    (window.__PI_STUB__?.argCalls ?? [])
      .filter((c) => c.cmd === 'connectors_create')
      .map((c) => c.args.input),
  )
  assert(
    '连接器导入：每项走 connectors_create 主路径（无批量旁路）',
    connCreates.length === 2 &&
      connCreates.some((i) => i.server_name === 'graphify' && i.transport === 'stdio' && i.command === '/Users/test/.local/bin/graphify-mcp') &&
      connCreates.some((i) => i.server_name === 'team-memory' && i.transport === 'streamable-http' && i.url === 'http://127.0.0.1:18950/mcp'),
    JSON.stringify(connCreates).slice(0, 240),
  )
  assert(
    '连接器导入：凭据不迁移（authorization_token 恒空）',
    connCreates.every((i) => !i.authorization_token),
    JSON.stringify(connCreates.map((i) => i.authorization_token)),
  )
  // 全部导入成功后弹窗自动收，列表刷新出两位新连接器。
  await page2.waitForTimeout(500)
  assert('连接器导入：成功后弹窗关闭', (await page2.locator('.modal-panel .ci-list').count()) === 0)
  const cpItems = (await page2.locator('.cp-item').allInnerTexts()).join(' | ')
  assert(
    '连接器导入：列表回显导入结果',
    cpItems.includes('graphify') && cpItems.includes('team-memory'),
    cpItems.slice(0, 120),
  )
  await page2.screenshot({ path: path.join(OUT, '43b-connector-imported.png'), animations: 'disabled' })
  const dangerIcons = await page2.evaluate(
    () => document.querySelectorAll('.cp-item-actions .cp-mini.danger').length,
  )
  assert('精细化：删除图标未确认前不显示 danger 描边', dangerIcons === 0, `count=${dangerIcons}`)

  const fatal = flowErrors.filter((t) => /Cannot read properties|is not a function|undefined is not/.test(t))
  assert('全流程：无渲染期崩溃', fatal.length === 0, fatal.slice(0, 2).join(' | ').slice(0, 120))
  await page2.close()

  // ── 9c. G4 会话持久化：新开一页（独立桩状态，active=pi-workbench + journal 回放数据），
  // 验证开页自动重建上次会话——user 气泡显示原文（preamble 已剥），assistant 文本回来，
  // 且别的项目段一条都不出现（多项目 journal 不分家）。──
  const page3 = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page3.on('pageerror', (e) => flowErrors.push(e.message))
  await page3.addInitScript(`window.__PI_REPLAY_MODE__ = true; window.__PI_REPLAY_ACTIVE__ = true`)
  await page3.addInitScript(PI_STUB_SCRIPT)
  await page3.goto(`http://localhost:${PORT}/#/chat`, { waitUntil: 'load' })
  await page3.waitForTimeout(900)
  const replayText = (await page3.locator('.msgs').innerText().catch(() => '')).replace(/\s+/g, ' ')
  assert(
    'G4：开页自动回放上次会话（user 原文 + assistant 文本）',
    replayText.includes('上次让我改索引') && replayText.includes('上次的回复：索引已修好。'),
    replayText.slice(0, 100),
  )
  assert(
    'G4：回放的 user 气泡剥掉了 preamble 前缀（不露项目上下文）',
    replayText.includes('上次让我改索引') && !replayText.includes('pi-workbench 的上下文'),
    replayText.slice(0, 100),
  )
  assert(
    'G4：多项目 journal 不分家——别的项目段不回放',
    !replayText.includes('别的项目探过去的历史消息'),
    replayText.slice(0, 100),
  )
  await page3.screenshot({ path: path.join(OUT, '42-g4-replay.png') })
  await page3.close()

  // ── 9d. G5 Plan 模式：scripted 桩（pi_send 后按内容推流式回复），
  // 验证「+ 菜单开计划模式 → 先出计划卡 → 点开始执行才动工具」的完整链路，
  // 以及 user 气泡不露计划指令、执行后模式自动回落默认（防无限计划循环）。
  // 计划开关不再是顶栏按钮：收进输入框 + 菜单的模式行，chip 回显激活态。──
  const page4 = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page4.on('pageerror', (e) => flowErrors.push(e.message))
  await page4.addInitScript(`window.__PI_SCRIPTED__ = true; window.__PI_REPLAY_ACTIVE__ = true`)
  await page4.addInitScript(PI_STUB_SCRIPT)
  await page4.goto(`http://localhost:${PORT}/#/chat`, { waitUntil: 'load' })
  await page4.waitForTimeout(800)

  // 会话态经 + 菜单选模式的通路（hero 与 composer 同组件，这里只走 composer）
  const p4PickMode = async (label) => {
    await page4.locator('.composer .cpm-trigger').click()
    await page4.waitForTimeout(200)
    await page4.locator('.cpm-menu .cpm-row', { hasText: '模式' }).click()
    await page4.waitForTimeout(150)
    await page4.locator('.cpm-menu .cpm-row', { hasText: label }).click()
    await page4.waitForTimeout(200)
  }

  // 第一条普通消息：离开落地页，会话态工具条挂着 + 菜单
  const p4Hero = page4.locator('.hero-input-wrap .app-textarea').first()
  await p4Hero.click()
  await page4.keyboard.type('先打个招呼')
  await page4.locator('.hero-send').click()
  await page4.waitForTimeout(900)
  assert(
    'G5：首条普通消息后进入会话流（+ 菜单可见）',
    (await page4.locator('.composer .cpm-trigger').count()) === 1,
    `count=${await page4.locator('.composer .cpm-trigger').count()}`,
  )

  // 开计划模式 → chip 回显激活态 → 发任务 → 先出计划卡（3 步 checklist）
  await p4PickMode('计划')
  assert(
    'G5：计划模式经 + 菜单开启后 chip 回显（激活态有视觉区分）',
    (await page4.locator('.composer .cpm-chip.mode').count()) === 1 &&
      (await page4.locator('.composer .cpm-chip.mode').innerText()).includes('计划'),
    await page4.locator('.composer .cpm-chip.mode').innerText().catch(() => 'none'),
  )
  const p4Composer = page4.locator('.composer .app-textarea').first()
  await p4Composer.click()
  await page4.keyboard.type('修一下索引死锁')
  await page4.locator('.composer .send').click()
  await page4.waitForTimeout(900)
  const p4Steps = await page4.locator('.plan-steps li').count()
  assert(
    'G5：plan 轮先出计划卡（3 步 checklist）',
    (await page4.locator('.plan-card').count()) === 1 && p4Steps === 3,
    `cards=${await page4.locator('.plan-card').count()} steps=${p4Steps}`,
  )
  const sentPlan = await page4.evaluate(() => window.__PI_STUB__.lastSent ?? '')
  assert(
    'G5：下发的正文带计划指令前缀（内核先出计划不动工具）',
    sentPlan.includes('[计划模式]'),
    sentPlan.slice(0, 60),
  )
  const p4Msgs = (await page4.locator('.msgs').innerText().catch(() => '')).replace(/\s+/g, ' ')
  assert(
    'G5：user 气泡不露计划指令（只显示原文）',
    p4Msgs.includes('修一下索引死锁') && !p4Msgs.includes('请先不要调用任何工具'),
    p4Msgs.slice(0, 80),
  )
  assert(
    'G5：计划卡带「开始执行 / 修改计划」两个动作',
    (await page4.getByTitle('按此计划执行（将作为新任务下发）').count()) === 1 &&
      (await page4.getByTitle('把计划步骤放回输入框修改').count()) === 1,
    `exec=${await page4.getByTitle('按此计划执行（将作为新任务下发）').count()} revise=${await page4.getByTitle('把计划步骤放回输入框修改').count()}`,
  )
  await page4.screenshot({ path: path.join(OUT, '43-plan-card.png') })

  // 点开始执行 → 计划卡转 executing，下发执行 prompt（已批准步骤 + 原始任务），开关自动关闭
  await page4.getByTitle('按此计划执行（将作为新任务下发）').click()
  await page4.waitForTimeout(900)
  const sentExec = await page4.evaluate(() => window.__PI_STUB__.lastSent ?? '')
  assert(
    'G5：确认后下发执行 prompt（已批准步骤 + 原始任务）',
    sentExec.includes('计划已确认') &&
      sentExec.includes('原始任务：修一下索引死锁') &&
      sentExec.includes('1. 定位索引死锁根因'),
    sentExec.slice(0, 90),
  )
  assert(
    'G5：执行后模式自动回落默认（chip 消失，防无限计划循环）',
    (await page4.locator('.composer .cpm-chip.mode').count()) === 0,
    'mode chip still there',
  )
  assert(
    'G5：计划卡进入 executing 态（按钮收起、显示执行中）',
    (await page4.locator('.plan-card.executing').count()) === 1 &&
      (await page4.locator('.plan-running').count()) === 1,
    `exec=${await page4.locator('.plan-card.executing').count()}`,
  )
  const p4Msgs2 = (await page4.locator('.msgs').innerText().catch(() => '')).replace(/\s+/g, ' ')
  assert(
    'G5：执行轮回复落进消息流',
    p4Msgs2.includes('已按批准的计划执行'),
    p4Msgs2.slice(-80),
  )
  await page4.screenshot({ path: path.join(OUT, '44-plan-executing.png') })
  await page4.close()

  // ── 9e. G6 消息队列 + mid-turn steer：slow 桩（首轮 1.4s 才 settled）创造
  // streaming 窗口——执行中发第二条进 follow_up 队列、点插话进 steer 队列，
  // 队列 chip 以内核 queue_update 回推为权威；本轮结束后按 steer→followUp
  // 顺序自动消费，且每条都在对话流里得到回复。清空可把文本恢复回输入框。──
  const page5 = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page5.on('pageerror', (e) => flowErrors.push(e.message))
  await page5.addInitScript(`window.__PI_SCRIPTED__ = true; window.__PI_REPLAY_ACTIVE__ = true; window.__PI_SLOW__ = true`)
  await page5.addInitScript(PI_STUB_SCRIPT)
  await page5.goto(`http://localhost:${PORT}/#/chat`, { waitUntil: 'load' })
  await page5.waitForTimeout(800)

  // 第一条：慢任务，制造 streaming 窗口
  const p5Hero = page5.locator('.hero-input-wrap .app-textarea').first()
  await p5Hero.click()
  await page5.keyboard.type('长任务：重构索引模块')
  await page5.locator('.hero-send').click()
  await page5.waitForTimeout(500)
  const p5Composer = page5.locator('.composer .app-textarea').first()
  await p5Composer.click()
  await page5.keyboard.type('顺便把测试补上')
  // 运行中发送键的位置切换为停止键（对齐主流输入区：同一个圆圈，不并排第二个按钮）。
  assert(
    'G6：运行中发送键位置显示停止键',
    (await page5.locator('.composer .stop').count()) === 1 &&
      (await page5.locator('.composer .send').count()) === 0,
    `stop=${await page5.locator('.composer .stop').count()} send=${await page5.locator('.composer .send').count()}`,
  )

  // 第二条：Enter 排队入队（follow_up）；发送键此刻是停止，不再承担排队。
  await page5.keyboard.press('Enter')
  await page5.waitForTimeout(400)
  const p5RpcTypes = await page5.evaluate(() => window.__PI_STUB__.rpcTypes ?? [])
  assert(
    'G6：streaming 中提交走内核 follow_up 入队',
    p5RpcTypes.includes('follow_up'),
    p5RpcTypes.slice(-4).join(','),
  )
  const p5QueueText = (await page5.locator('.queue-strip').innerText().catch(() => '')).replace(/\s+/g, ' ')
  assert(
    'G6：队列 strip 显示排队中的消息（本轮结束后执行）',
    p5QueueText.includes('排队') && p5QueueText.includes('顺便把测试补上'),
    p5QueueText.slice(0, 80),
  )
  const p5UserBubbles = await page5.locator('.msg-row.user').count()
  assert(
    'G6：排队消息同时落 user 气泡（对话流不断层）',
    p5UserBubbles === 2,
    `bubbles=${p5UserBubbles}`,
  )

  // 插话：steer 队列（下次 LLM 调用前注入）
  await p5Composer.click()
  await page5.keyboard.type('先别动配置')
  await page5.locator('.steer').click()
  await page5.waitForTimeout(300)
  const p5RpcTypes2 = await page5.evaluate(() => window.__PI_STUB__.rpcTypes ?? [])
  assert(
    'G6：插话按钮走内核 steer 注入',
    p5RpcTypes2.includes('steer'),
    p5RpcTypes2.slice(-4).join(','),
  )
  const p5QueueText2 = (await page5.locator('.queue-strip').innerText().catch(() => '')).replace(/\s+/g, ' ')
  assert(
    'G6：插话消息进 steer 段（下一轮模型调用前注入）',
    p5QueueText2.includes('插话') && p5QueueText2.includes('先别动配置'),
    p5QueueText2.slice(0, 100),
  )
  await page5.screenshot({ path: path.join(OUT, '45-queue-steer.png') })

  // 本轮结束：内核按 steer → followUp 顺序自动消费，队列清空、两条都得到回复
  await page5.waitForTimeout(4500)
  assert(
    'G6：本轮结束后队列自动消费完（strip 消失）',
    (await page5.locator('.queue-strip').count()) === 0,
    `strip=${await page5.locator('.queue-strip').count()}`,
  )
  const p5Msgs = (await page5.locator('.msgs').innerText().catch(() => '')).replace(/\s+/g, ' ')
  assert(
    'G6：队列消息按序得到回复（steer 优先于 followUp）',
    p5Msgs.includes('已处理：先别动配置') && p5Msgs.includes('已处理：顺便把测试补上'),
    p5Msgs.slice(-100),
  )
  if (process.env.DBG_PLAN) {
    const dbg = await page5.evaluate(() => ({
      rows: [...document.querySelectorAll('.msg-row.assistant')].map((el) => ({
        usage: !!el.querySelector('.msg-usage'),
        cursor: !!el.querySelector('.cursor'),
        tail: (el.textContent ?? '').slice(0, 24),
      })),
      liveSteps: document.querySelectorAll('.turn-status').length,
      q: window.__PI_STUB__.q,
    }))
    console.log('DBG drained:', JSON.stringify(dbg))
  }
  await page5.screenshot({ path: path.join(OUT, '46-queue-drained.png') })

  // 清空可撤销：再发一个慢任务，流式中排一条 → 清空 → 文本恢复回输入框（不白打一遍字）
  const p5Composer2 = page5.locator('.composer .app-textarea').first()
  await p5Composer2.click()
  await page5.keyboard.type('第二批慢任务')
  await page5.locator('.composer .send').click()
  await page5.waitForTimeout(350)
  await p5Composer2.click()
  await page5.keyboard.type('再排一条')
  // 运行中发送键位置是停止键，排队走 Enter（与手动使用一致）。
  await page5.keyboard.press('Enter')
  await page5.waitForTimeout(300)
  assert(
    'G6：清空前队列里有一条待执行',
    (await page5.locator('.queue-item').count()) === 1,
    `items=${await page5.locator('.queue-item').count()}`,
  )
  await page5.locator('.queue-clear').click()
  await page5.waitForTimeout(300)
  assert(
    'G6：清空后队列 strip 消失',
    (await page5.locator('.queue-strip').count()) === 0,
    `strip=${await page5.locator('.queue-strip').count()}`,
  )
  const p5DraftRestored = await page5.locator('.composer .app-textarea').first().inputValue()
  assert(
    'G6：被清出的文本恢复回输入框',
    p5DraftRestored.includes('再排一条'),
    p5DraftRestored.slice(0, 60),
  )
  // 清空后主任务照常收尾，被清的条目不再被执行（对话流里不出现它的回复）
  await page5.waitForTimeout(2600)
  const p5Msgs2 = (await page5.locator('.msgs').innerText().catch(() => '')).replace(/\s+/g, ' ')
  assert(
    'G6：清空后条目不再执行（无「已处理：再排一条」）',
    !p5Msgs2.includes('已处理：再排一条'),
    p5Msgs2.slice(-80),
  )
  await page5.screenshot({ path: path.join(OUT, '46-queue-clear.png') })

  // 请求链路：气泡下不再有内联入口（右侧轨迹面板已完整覆盖，内联那行是重复占高）。
  // 入口统一收进面板：点 .trace-toggle 展开抽屉，图的断言不变。
  const runEntries = page5.locator('.msgs .run-entry')
  assert(
    '请求链路：气泡下不再重复渲染「运行链路」入口',
    (await runEntries.count()) === 0,
    `entries=${await runEntries.count()}`,
  )
  await page5.locator('.trace-toggle').click()
  await page5.waitForTimeout(500)
  assert('请求链路：点面板入口展开轨迹抽屉', (await page5.locator('.trace-drawer.open').count()) === 1)
  const graph = page5.locator('.trace-drawer .run-graph').last()
  const graphNodes = await graph.locator('.rg-node').count()
  const failedNodes = await page5.locator('.trace-drawer .rg-node.is-failed').count()
  // 旧轮次默认折叠成一行（防止长会话把事件列表挤成 0 高），所以只断言当前这一轮：
  // 该轮的每个环节都要有节点，且失败环节单独标红。
  assert('请求链路：抽屉里按节点渲染整条链路', graphNodes >= 5, `nodes=${graphNodes}`)
  assert('请求链路：失败环节独立标红，不被算成完成', failedNodes >= 1, `failed=${failedNodes}`)
  const geo = await inspectRunGraph(graph)
  assert('请求链路：节点不重叠', geo.overlaps === 0, `overlaps=${geo.overlaps}`)
  assert('请求链路：连线不穿节点', geo.crossings === 0, `crossings=${geo.crossings}`)
  assert('请求链路：文字不被裁', geo.clipped === 0, `clipped=${geo.clipped}`)
  assert('请求链路：图不产生横向溢出', geo.overflow <= 1, `overflow=${geo.overflow}`)
  await page5.locator('.trace-drawer .rg-node.is-failed').first().click()
  await page5.waitForTimeout(150)
  const detailCount = await page5.locator('.trace-drawer .rg-detail').count()
  const rawLen = (await page5.locator('.trace-drawer .rg-raw').innerText().catch(() => '')).length
  assert('请求链路：点节点展开输入/输出/原始事件', detailCount === 1 && rawLen > 10, `raw=${rawLen}`)

  // 抖动闸门：追加事件、每秒耗时刷新都不许挪动既有节点或滚动容器。
  // 曾经的回归是图每帧从环形缓冲全量重建，旧行被淘汰时节点消失、整图缩水一帧上移。
  const shake = await page5.evaluate(async () => {
    const panel = document.querySelector('.trace-drawer .activity-panel')
    if (panel) panel.scrollTop = 0
    // 图区自己也是滚动容器（max-height + overflow:auto）：上一步点节点触发的
    // scrollIntoView 平滑滚动会落在这里，基准同样归零，否则量到的是那段动画。
    const rgBox = document.querySelector('.trace-drawer .run-graphs')
    if (rgBox) rgBox.scrollTop = 0
    const sample = () => {
      const graphs = [...document.querySelectorAll('.trace-drawer .run-graph')]
      const g = graphs.at(-1)
      const svg = g?.querySelector('.rg-svg')
      return {
        run: g?.getAttribute('data-run-id'),
        top: g ? Math.round(g.getBoundingClientRect().top * 10) / 10 : null,
        scrollTop: Math.round((panel?.scrollTop ?? 0) * 10) / 10,
        svgH: Number(svg?.getAttribute('height')),
        nodes: [...(g?.querySelectorAll('.rg-node') ?? [])].map((n) => ({
          k: n.querySelector('.rg-node-title')?.textContent ?? '',
          y: Number(n.querySelector('.rg-box')?.getAttribute('y')),
        })),
      }
    }
    const emit = (rec) => window.__PI_STUB__.emitPi(rec)
    const runId = 'run-jitter-guard'
    const t0 = Date.now()
    const base = { runId, runStartedAt: t0 }
    emit({ type: 'run_start', ...base, agentId: 'main', prompt: '抖动闸门', pi_ts: t0 })
    // 等新轮次的图挂上、且连续两帧位置一致再取基准：轮次切换会把上一轮从展开图折成一行，
    // 折叠发生在切换后的下一拍，一帧就采样会把「折叠」算成「追加事件挪了图」。
    let before = sample()
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => requestAnimationFrame(r))
      const s = sample()
      if (s.run === runId && s.top === before.top && s.top != null) break
      before = s
    }
    for (let i = 0; i < 3; i++) {
      const t = Date.now()
      const span = { ...base, agentId: 'main', spanId: `guard-${i}`, spanKind: 'tool' }
      emit({ type: 'tool_execution_start', toolCallId: `guard-${i}`, toolName: 'bash', args: { command: 'ls' }, ...span, spanStartedAt: t, pi_ts: t })
      emit({ type: 'tool_execution_end', toolCallId: `guard-${i}`, toolName: 'bash', args: { command: 'ls' }, result: { content: [{ type: 'text', text: 'ok' }] }, ...span, spanStartedAt: t, spanEndedAt: t + 10, pi_ts: t + 10 })
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    }
    const after = sample()
    // 跨过一次每秒耗时刷新：只允许文字变，几何与滚动必须原地不动。
    await new Promise((r) => setTimeout(r, 1300))
    const ticked = sample()
    return { runId, before, after, ticked }
  })
  const samePrefix = (a, b) =>
    a.nodes.length <= b.nodes.length &&
    a.nodes.every((n, i) => n.k === b.nodes[i].k && n.y === b.nodes[i].y)
  assert(
    '请求链路：追加事件既有节点不重排（顺序与坐标不变）',
    shake.after.run === shake.runId && shake.after.nodes.length > shake.before.nodes.length && samePrefix(shake.before, shake.after),
    `before=${shake.before.nodes.map((n) => n.y).join(',')} after=${shake.after.nodes.map((n) => n.y).join(',')}`,
  )
  assert(
    '请求链路：追加事件不推动滚动容器与图位置',
    shake.after.scrollTop === shake.before.scrollTop && shake.after.top === shake.before.top,
    `scroll=${shake.before.scrollTop}→${shake.after.scrollTop} top=${shake.before.top}→${shake.after.top}`,
  )
  assert(
    '请求链路：每秒耗时刷新只改文字，不触发布局',
    shake.ticked.nodes.length === shake.after.nodes.length &&
      shake.ticked.svgH === shake.after.svgH &&
      shake.ticked.top === shake.after.top &&
      shake.ticked.scrollTop === shake.after.scrollTop &&
      samePrefix(shake.after, shake.ticked),
    `svgH=${shake.after.svgH}→${shake.ticked.svgH} top=${shake.after.top}→${shake.ticked.top}`,
  )

  await page5.screenshot({ path: path.join(OUT, '49-run-graph-1440.png') })
  await page5.close()

  // ── 9f. #67 M1/M2：编辑重开 + 刷新末条（scripted 桩，回复自动落定）。
  // 锁的是完整链路：就地编辑 → checkpoint 回滚 → 截断 → 重派；刷新末条 →
  // 撤该轮 → 同文本重派；回滚失败必须落「对话编辑/重发失败」进消息流。──
  const page6 = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page6.on('pageerror', (e) => flowErrors.push(e.message))
  await page6.addInitScript(`window.__PI_SCRIPTED__ = true; window.__PI_REPLAY_ACTIVE__ = true`)
  await page6.addInitScript(PI_STUB_SCRIPT)
  await page6.goto(`http://localhost:${PORT}/#/chat`, { waitUntil: 'load' })
  await page6.waitForTimeout(800)

  // 两轮对话：第一条从 hero 发（拿到 turnSeq=1），第二条从 composer 发（turnSeq=2）
  const p6Hero = page6.locator('.hero-input-wrap .app-textarea').first()
  await p6Hero.click()
  await page6.keyboard.type('第一条任务')
  await page6.locator('.hero-send').click()
  await page6.waitForTimeout(900)
  const p6Composer = page6.locator('.composer .app-textarea').first()
  await p6Composer.click()
  await page6.keyboard.type('第二条任务')
  await page6.locator('.composer .send').click()
  await page6.waitForTimeout(900)

  const p6UserRows = page6.locator('.msg-row.user')
  assert(
    '#67：两条带 checkpoint 的 user 消息各有一个「编辑」入口',
    (await p6UserRows.count()) === 2 && (await page6.locator('.edit-btn').count()) === 2,
    `rows=${await p6UserRows.count()} edit=${await page6.locator('.edit-btn').count()}`,
  )

  // M1：编辑第一条 → 就地编辑区替换气泡 → 改文本 → 重新发送
  await p6UserRows.first().locator('.edit-btn').click()
  await page6.waitForTimeout(200)
  const editBox = page6.locator('.edit-box')
  const editHint = (await page6.locator('.edit-hint').innerText().catch(() => '')).trim()
  assert(
    '#67 M1：编辑态原位替换气泡并提示「编辑后将从此处重新开始对话」',
    (await editBox.count()) === 1 &&
      editHint.includes('编辑后将从此处重新开始对话') &&
      (await p6UserRows.first().locator('.txt').count()) === 0,
    `box=${await editBox.count()} hint=${editHint}`,
  )
  await page6.screenshot({ path: path.join(OUT, '50-edit-inline.png') })
  const p6EditArea = editBox.locator('.edit-area')
  await p6EditArea.fill('改过的任务')
  await editBox.locator('.edit-resend').click()
  await page6.waitForTimeout(1000)
  const p6Rewind1 = await page6.evaluate(() => window.__PI_STUB__.rewound ?? null)
  const p6MsgsAfterEdit = (await page6.locator('.msgs').innerText()).replace(/\s+/g, ' ')
  assert(
    '#67 M1：确认后回滚到第 1 轮（checkpoint_rewind seq=1）',
    !!p6Rewind1 && Number(p6Rewind1.seq) === 1,
    JSON.stringify(p6Rewind1),
  )
  assert(
    '#67 M1：该轮起全部消息被截断，编辑后文本重新出现在流里',
    p6MsgsAfterEdit.includes('改过的任务') &&
      !p6MsgsAfterEdit.includes('第一条任务') &&
      !p6MsgsAfterEdit.includes('第二条任务'),
    p6MsgsAfterEdit.slice(0, 120),
  )
  const p6SentAfterEdit = await page6.evaluate(() => window.__PI_STUB__.lastSent ?? '')
  assert(
    '#67 M1：重发下发的是编辑后文本（内核收到的正文含新措辞）',
    p6SentAfterEdit.includes('改过的任务'),
    p6SentAfterEdit.slice(0, 80),
  )
  await page6.screenshot({ path: path.join(OUT, '51-edit-resent.png') })

  // M2：末尾轮操作行有刷新键 → 点击 → 撤该轮 + 同文本重派
  assert(
    '#67 M2：仅末尾轮操作行出现刷新键',
    (await page6.locator('.regen-btn').count()) === 1,
    `count=${await page6.locator('.regen-btn').count()}`,
  )
  await page6.locator('.regen-btn').click()
  await page6.waitForTimeout(1000)
  const p6Rewind2 = await page6.evaluate(() => window.__PI_STUB__.rewound ?? null)
  const p6MsgsAfterRegen = (await page6.locator('.msgs').innerText()).replace(/\s+/g, ' ')
  assert(
    '#67 M2：刷新末条回滚到最后一条提问（seq=3，M1 重发后的新轮）',
    !!p6Rewind2 && Number(p6Rewind2.seq) === 3,
    JSON.stringify(p6Rewind2),
  )
  assert(
    '#67 M2：同文本重发后提问仍在、回复重新生成',
    p6MsgsAfterRegen.includes('改过的任务') && p6MsgsAfterRegen.includes('收到，已处理'),
    p6MsgsAfterRegen.slice(-120),
  )
  await page6.screenshot({ path: path.join(OUT, '52-regen-last.png') })

  // 失败路径：回滚 rejection 必须落「对话编辑失败」进消息流（静默失败是旧病灶）
  await page6.evaluate(() => {
    window.__PI_STUB__.failRewind = true
  })
  await page6.locator('.msg-row.user').first().locator('.edit-btn').click()
  await page6.waitForTimeout(200)
  await page6.locator('.edit-box .edit-area').fill('会失败的编辑')
  await page6.locator('.edit-box .edit-resend').click()
  await page6.waitForTimeout(600)
  const p6MsgsFail = (await page6.locator('.msgs').innerText()).replace(/\s+/g, ' ')
  assert(
    '#67：回滚失败落进消息流（「对话编辑失败，请稍后重试」，不静默）',
    p6MsgsFail.includes('对话编辑失败'),
    p6MsgsFail.slice(-100),
  )
  await page6.evaluate(() => {
    window.__PI_STUB__.failRewind = false
  })
  await page6.close()

  // ── 9g. #68 M6+C2：提问导航刻度条（右侧竖条）与顶栏「历史提问」入口。
  // 锁的是三层分工：阈值（≥4 轮 + 宿主 ≥560）只约束刻度列常驻；列表展开
  // 两源（hover / 顶栏）不受轮数约束；滚动折算与定位归 MessageList；
  // 独立回放窗口（?replay= 深链）不出导航。──
  const page6b = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page6b.on('pageerror', (e) => flowErrors.push(e.message))
  await page6b.addInitScript(`window.__PI_SCRIPTED__ = true; window.__PI_REPLAY_ACTIVE__ = true`)
  await page6b.addInitScript(PI_STUB_SCRIPT)
  await page6b.goto(`http://localhost:${PORT}/#/chat`, { waitUntil: 'load' })
  await page6b.waitForTimeout(800)

  // 六轮对话（hero 发第一条，composer 补五条）：前三轮验证阈值下刻度列不出现，
  // 第六轮过线后一提问一刻度。内容高度足以溢出滚动容器，跳转对齐断言才成立。
  const p6bHero = page6b.locator('.hero-input-wrap .app-textarea').first()
  await p6bHero.click()
  await page6b.keyboard.type('第一条任务')
  await page6b.locator('.hero-send').click()
  await page6b.waitForTimeout(900)
  const p6bComposer = page6b.locator('.composer .app-textarea').first()
  for (let i = 2; i <= 6; i++) {
    await p6bComposer.click()
    await page6b.keyboard.type(`第${['二', '三', '四', '五', '六'][i - 2]}条任务`)
    await page6b.locator('.composer .send').click()
    await page6b.waitForTimeout(900)
    if (i === 3) {
      assert(
        '#68 M6：不足 4 轮 → 刻度列不常驻（哨兵挂载、刻度为零）',
        (await page6b.locator('.prompt-rail').count()) === 1 &&
          (await page6b.locator('.pr-tick').count()) === 0,
        `rail=${await page6b.locator('.prompt-rail').count()} ticks=${await page6b.locator('.pr-tick').count()}`,
      )
    }
  }
  assert(
    '#68 M6：≥4 轮后一提问一刻度，且当前提问的刻度唯一',
    (await page6b.locator('.pr-tick').count()) === 6 &&
      (await page6b.locator('.pr-tick.active').count()) === 1,
    `ticks=${await page6b.locator('.pr-tick').count()} active=${await page6b.locator('.pr-tick.active').count()}`,
  )
  assert(
    '#68 C2：顶栏「历史提问」入口在控组首位',
    (await page6b.locator('.prompts-btn').count()) === 1 &&
      (await page6b.locator('.prompts-btn').getAttribute('title')) === '历史提问：跳转导航',
    `btn=${await page6b.locator('.prompts-btn').count()}`,
  )

  // 几何：刻度列与 user 气泡不相叠、不越出 .center 右缘——absolute 挂 center
  // 的净收益要经得起量，抽屉/窄栏下挤进正文就是缺陷。贴底的末条一定在视口内，
  // 拿它量横向间隙（首条此时已滚出，boundingBox 可能为 null）。
  const p6bGeom = await page6b.evaluate(() => {
    const tick = document.querySelector('.pr-tick')
    const rows = document.querySelectorAll('.msg-row.user')
    const row = rows[rows.length - 1]
    const center = document.querySelector('.center')
    if (!tick || !row || !center) return null
    const t = tick.getBoundingClientRect()
    const r = row.getBoundingClientRect()
    const c = center.getBoundingClientRect()
    return { gap: t.left - r.right, over: t.right - c.right }
  })
  assert(
    '#68 M6：刻度列贴在正文右侧，不与气泡重叠、不越出容器',
    !!p6bGeom && p6bGeom.gap >= 8 && p6bGeom.over <= 0,
    JSON.stringify(p6bGeom),
  )

  // hover 刻度列 → 列表展开（两源之一）；移出即收起
  await page6b.locator('.prompt-rail').hover()
  await page6b.waitForTimeout(200)
  const p6bListItems = page6b.locator('.pr-item')
  const p6bHeadText = (await page6b.locator('.pr-list-head').innerText().catch(() => '')).replace(/\s+/g, '')
  assert(
    '#68 M6：hover 刻度列展开提问列表，头栏带计数',
    (await p6bListItems.count()) === 6 && p6bHeadText.includes('历史提问') && p6bHeadText.includes('6条'),
    `items=${await p6bListItems.count()} head=${p6bHeadText}`,
  )
  await page6b.mouse.move(200, 200)
  await page6b.waitForTimeout(200)
  assert(
    '#68 M6：移出刻度列后列表收起（hover 态不粘滞）',
    (await page6b.locator('.pr-list').count()) === 0,
    `list=${await page6b.locator('.pr-list').count()}`,
  )

  // 点第一条刻度 → MessageList.scrollToPrompt：该 user 行首贴到视口顶，高亮跟过去
  await page6b.locator('.pr-tick').first().click()
  await page6b.waitForTimeout(300)
  const p6bAlign = await page6b.evaluate(() => {
    const msgs = document.querySelector('.msgs')
    const row = msgs?.querySelector('.msg-row.user[data-mid]')
    if (!msgs || !row) return null
    return {
      delta: Math.abs(row.getBoundingClientRect().top - msgs.getBoundingClientRect().top),
      activeIdx: Array.from(document.querySelectorAll('.pr-tick')).findIndex((t) =>
        t.classList.contains('active'),
      ),
    }
  })
  await page6b.mouse.move(200, 200)
  await page6b.waitForTimeout(150)
  assert(
    '#68 M6：点刻度定位——首条 user 行贴到视口顶，当前刻度切到第一条',
    !!p6bAlign && p6bAlign.delta <= 3 && p6bAlign.activeIdx === 0,
    JSON.stringify(p6bAlign),
  )
  await page6b.screenshot({ path: path.join(OUT, '53-prompt-rail.png') })

  // 手动滚回底部 → 滚动折算把高亮带走（不是只跟程序滚动）
  await page6b.evaluate(() => {
    const msgs = document.querySelector('.msgs')
    msgs.scrollTop = msgs.scrollHeight
  })
  await page6b.waitForTimeout(300)
  const p6bActiveAfterBottom = await page6b.evaluate(
    () => Array.from(document.querySelectorAll('.pr-tick')).findIndex((t) => t.classList.contains('active')),
  )
  assert(
    '#68 M6：手动滚动同步高亮——滚到底后当前刻度离开第一条',
    p6bActiveAfterBottom > 0,
    `activeIdx=${p6bActiveAfterBottom}`,
  )

  // C2 顶栏入口 → 列表展开（第二源）；点列表项 → 跳转 + 收起 + aria 回落
  await page6b.locator('.prompts-btn').click()
  await page6b.waitForTimeout(200)
  assert(
    '#68 C2：顶栏按钮展开列表且 aria-expanded 同步',
    (await page6b.locator('.pr-list').count()) === 1 &&
      (await page6b.locator('.prompts-btn').getAttribute('aria-expanded')) === 'true',
    `list=${await page6b.locator('.pr-list').count()}`,
  )
  await page6b.locator('.pr-item').first().click()
  await page6b.waitForTimeout(300)
  const p6bAfterNav = await page6b.evaluate(() => {
    const msgs = document.querySelector('.msgs')
    const row = msgs?.querySelector('.msg-row.user[data-mid]')
    return {
      list: document.querySelectorAll('.pr-list').length,
      expanded: document.querySelector('.prompts-btn')?.getAttribute('aria-expanded'),
      delta: row ? Math.abs(row.getBoundingClientRect().top - msgs.getBoundingClientRect().top) : 999,
    }
  })
  assert(
    '#68 C2：点列表项跳转后浮层让位——列表收起、aria 回落、首条提问贴顶',
    p6bAfterNav.list === 0 && p6bAfterNav.expanded === 'false' && p6bAfterNav.delta <= 3,
    JSON.stringify(p6bAfterNav),
  )

  // 宽度阈值：窗口收到 600px（≤900 断点侧栏自动收成 68px 图标轨，.center ≈532
  // < 560）→ 刻度列隐藏；拉回来 ResizeObserver 即时重算再出现（哨兵常驻的意义
  // 就在这里——v-if 会把观察者连同组件卸掉，变宽的事件永远不会发生）。
  await page6b.setViewportSize({ width: 600, height: 900 })
  await page6b.waitForTimeout(400)
  const p6bNarrowTicks = await page6b.locator('.pr-tick').count()
  await page6b.setViewportSize({ width: 1440, height: 900 })
  await page6b.waitForTimeout(400)
  assert(
    '#68 M6：宿主宽度阈值——.center < 560 隐藏刻度列，拉宽后即时恢复',
    p6bNarrowTicks === 0 && (await page6b.locator('.pr-tick').count()) === 6,
    `narrow=${p6bNarrowTicks} wide=${await page6b.locator('.pr-tick').count()}`,
  )
  await page6b.close()

  // 回放窗口门槛：?replay= 深链独立窗口里导航整体不出现——回放的是一份
  // 历史档案，在里面跳提问没有语义。消息照常重建，唯独导航缺席。
  const page6c = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page6c.on('pageerror', (e) => flowErrors.push(e.message))
  await page6c.addInitScript(`window.__PI_REPLAY_MODE__ = true; window.__PI_REPLAY_ACTIVE__ = true`)
  await page6c.addInitScript(PI_STUB_SCRIPT)
  await page6c.goto(`http://localhost:${PORT}/#/chat?replay=1`, { waitUntil: 'load' })
  await page6c.waitForTimeout(900)
  const p6cText = (await page6c.locator('.msgs').innerText().catch(() => '')).replace(/\s+/g, ' ')
  assert(
    '#68：独立回放窗口（?replay= 深链）消息重建但导航不出现——刻度条与顶栏入口双双让位',
    p6cText.includes('上次让我改索引') &&
      (await page6c.locator('.prompt-rail').count()) === 0 &&
      (await page6c.locator('.prompts-btn').count()) === 0,
    `msgs=${p6cText.slice(0, 60)} rail=${await page6c.locator('.prompt-rail').count()} btn=${await page6c.locator('.prompts-btn').count()}`,
  )
  await page6c.close()

  // ── 9h. #69 M10 粘贴字节：剪贴板图片（无磁盘路径）→ base64 →
  // attachment_add_bytes → 同一附件托盘。锁三件事：图片粘贴出图卡、
  // 纯文本粘贴不占托盘（默认行为不拦）、焦点不在对话区不抢粘贴。──
  const page7 = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page7.on('pageerror', (e) => flowErrors.push(e.message))
  await page7.addInitScript(`window.__PI_SCRIPTED__ = true; window.__PI_REPLAY_ACTIVE__ = true`)
  await page7.addInitScript(PI_STUB_SCRIPT)
  await page7.goto(`http://localhost:${PORT}/#/chat`, { waitUntil: 'load' })
  await page7.waitForTimeout(800)

  // 1×1 PNG 的最小合法字节头就够——桩不校验内容，真机 Rust 侧只量长度。
  const p7Paste = async (sel, mime) =>
    page7.evaluate(
      ([s, m]) => {
        const el = document.querySelector(s)
        if (!el) return false
        el.focus()
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
        const dt = new DataTransfer()
        if (m) dt.items.add(new File([bytes], 'clip', { type: m }))
        else dt.setData('text/plain', '纯文本')
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
        return true
      },
      [sel, mime],
    )

  const p7HeroArea = '.hero-input-wrap .app-textarea'
  await p7Paste(p7HeroArea, 'image/png')
  await page7.waitForTimeout(300)
  const p7Chips = page7.locator('.att-chip')
  assert(
    '#69 M10：hero 粘贴图片 → 附件托盘出图卡（粘贴字节与拖拽同一通道收口）',
    (await p7Chips.count()) === 1 &&
      (await p7Chips.first().getAttribute('class'))?.includes('image') &&
      (await p7Chips.locator('.att-name').innerText()).includes('粘贴图片'),
    `chips=${await p7Chips.count()} name=${await p7Chips.locator('.att-name').innerText().catch(() => '')}`,
  )
  // 纯文本粘贴：不 preventDefault、不产卡——默认行为归 textarea 自己。
  await p7Paste(p7HeroArea, null)
  await page7.waitForTimeout(200)
  assert(
    '#69 M10：纯文本粘贴不占附件托盘（判定只认 image/* 条目）',
    (await p7Chips.count()) === 1,
    `chips=${await p7Chips.count()}`,
  )
  // 会话态 composer 同样挂得上的判定（窗口级监听、两态共用）。
  await page7.locator(p7HeroArea).fill('粘贴测试任务')
  await page7.locator('.hero-send').click()
  await page7.waitForTimeout(900)
  await p7Paste('.composer .app-textarea', 'image/webp')
  await page7.waitForTimeout(300)
  assert(
    '#69 M10：会话态 composer 粘贴同样落托盘（窗口级监听两态共用）',
    (await page7.locator('.composer .att-chip').count()) === 1,
    `chips=${await page7.locator('.composer .att-chip').count()}`,
  )
  await page7.screenshot({ path: path.join(OUT, '54-paste-attach.png') })
  await page7.close()

  // ── 9i. #69 M7 队列重排：慢桩流式窗口里排 2 条 followUp + 1 条 steer，
  // 四个入口（↑↓ / 拖拽 / 编辑 / 删除）全部走 clear→快照→变更→重发编排。
  // 断言抓「内核回推后的 strip 状态」而非前端副账——跨段移动 = 类型转换
  // （排队项拖进插话段就变下次注入），编辑只换正文、标记块原样带回，
  // 删除项不再被执行，消费顺序 = 重排后的新序。──
  const page8 = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page8.on('pageerror', (e) => flowErrors.push(e.message))
  await page8.addInitScript(`window.__PI_SCRIPTED__ = true; window.__PI_REPLAY_ACTIVE__ = true; window.__PI_SLOW__ = true`)
  await page8.addInitScript(PI_STUB_SCRIPT)
  await page8.goto(`http://localhost:${PORT}/#/chat`, { waitUntil: 'load' })
  await page8.waitForTimeout(800)

  const p8Hero = page8.locator('.hero-input-wrap .app-textarea').first()
  await p8Hero.click()
  await page8.keyboard.type('慢任务重排')
  await page8.locator('.hero-send').click()
  await page8.waitForTimeout(300)
  const p8Composer = page8.locator('.composer .app-textarea').first()
  // 流式窗口（首轮 4s 才 settled）里塞三条：两条排队、一条插话
  for (const text of ['排甲', '排乙']) {
    await p8Composer.click()
    await page8.keyboard.type(text)
    await page8.keyboard.press('Enter')
    await page8.waitForTimeout(200)
  }
  await p8Composer.click()
  await page8.keyboard.type('插丙')
  await page8.locator('.steer').click()
  await page8.waitForTimeout(250)

  const p8Texts = async () => (await page8.locator('.queue-item-text').allInnerTexts()).map((s) => s.trim())
  const p8SegTexts = async (seg) =>
    (await page8.locator(`.queue-seg.${seg} .queue-item-text`).allInnerTexts()).map((s) => s.trim())

  assert(
    '#69 M7：入队后 strip 顺序 = steer 段在前（与内核消费顺序同序）',
    JSON.stringify(await p8Texts()) === JSON.stringify(['插丙', '排甲', '排乙']),
    `items=${JSON.stringify(await p8Texts())}`,
  )

  // 入口一：点「排甲」的上移（扁平 1 → 0）——跨过插话项 = 类型转换，排甲进 steer 段
  const p8Up = page8.locator('.queue-item').nth(1).locator('.queue-act').nth(0)
  await p8Up.click()
  await page8.waitForTimeout(300)
  assert(
    '#69 M7：跨段上移 = 排队项转插话（段归属跟随落点邻居）',
    JSON.stringify(await p8SegTexts('steer')) === JSON.stringify(['排甲', '插丙']) &&
      JSON.stringify(await p8SegTexts('followup')) === JSON.stringify(['排乙']),
    `steer=${JSON.stringify(await p8SegTexts('steer'))} fu=${JSON.stringify(await p8SegTexts('followup'))}`,
  )
  const p8RpcAfterMove = await page8.evaluate(() => window.__PI_STUB__.rpcTypes ?? [])
  assert(
    '#69 M7：重排走 clear+重发编排（clear_queue 出现在 RPC 流）',
    p8RpcAfterMove.includes('clear_queue'),
    p8RpcAfterMove.slice(-6).join(','),
  )

  // 入口二：拖拽——末条「排乙」（扁平 2）拖到「插丙」（扁平 1）上。
  // 合成事件直发（drag 处理器只吃索引，不依赖真实指针轨迹），确定性优先。
  await page8.evaluate(() => {
    const items = [...document.querySelectorAll('.queue-item')]
    items[2].dispatchEvent(new Event('dragstart'))
    items[1].dispatchEvent(new Event('dragover'))
    items[1].dispatchEvent(new Event('drop'))
  })
  await page8.waitForTimeout(300)
  assert(
    '#69 M7：拖拽重排后三条全落插话段（新序 排甲→排乙→插丙）',
    JSON.stringify(await p8SegTexts('steer')) === JSON.stringify(['排甲', '排乙', '插丙']) &&
      (await page8.locator('.queue-seg.followup').count()) === 0,
    `steer=${JSON.stringify(await p8SegTexts('steer'))} fuSeg=${await page8.locator('.queue-seg.followup').count()}`,
  )
  await page8.screenshot({ path: path.join(OUT, '55-queue-reorder.png') })

  // 入口三：编辑「插丙」（扁平 2）——弹窗预填纯正文，保存只换文本
  await page8.locator('.queue-item').nth(2).locator('.queue-act').nth(2).click()
  await page8.waitForTimeout(250)
  const p8EditArea = page8.locator('.modal-backdrop .app-textarea').first()
  assert(
    '#69 M7：编辑弹窗预填正文（不含 buildPrompt 标记语法）',
    (await p8EditArea.inputValue().catch(() => '')) === '插丙',
    `val=${await p8EditArea.inputValue().catch(() => 'ERR')}`,
  )
  await p8EditArea.fill('插丙改')
  await page8.locator('.modal-backdrop .v-primary').first().click()
  await page8.waitForTimeout(300)
  assert(
    '#69 M7：编辑保存后 strip 显示新文本（queue_update 回推收敛）',
    (await p8Texts()).includes('插丙改') && !(await p8Texts()).includes('插丙'),
    `items=${JSON.stringify(await p8Texts())}`,
  )

  // 入口四：删除「排乙」（扁平 1）
  await page8.locator('.queue-item').nth(1).locator('.queue-act').nth(3).click()
  await page8.waitForTimeout(300)
  assert(
    '#69 M7：删除后条目数与顺序收敛（剩 排甲→插丙改）',
    JSON.stringify(await p8Texts()) === JSON.stringify(['排甲', '插丙改']),
    `items=${JSON.stringify(await p8Texts())}`,
  )

  // 本轮结束：内核按重排后的新序消费（steer 段 排甲→插丙改），被删的排乙不再执行
  await page8.waitForTimeout(6000)
  assert(
    '#69 M7：消费完队列清空（strip 消失）',
    (await page8.locator('.queue-strip').count()) === 0,
    `strip=${await page8.locator('.queue-strip').count()}`,
  )
  const p8Msgs = (await page8.locator('.msgs').innerText().catch(() => '')).replace(/\s+/g, ' ')
  assert(
    '#69 M7：回复按新序落地（排甲 先于 插丙改）',
    p8Msgs.includes('已处理：排甲') &&
      p8Msgs.includes('已处理：插丙改') &&
      p8Msgs.indexOf('已处理：排甲') < p8Msgs.indexOf('已处理：插丙改'),
    p8Msgs.slice(-120),
  )
  assert(
    '#69 M7：被删条目不再执行（无「已处理：排乙」）',
    !p8Msgs.includes('已处理：排乙'),
    p8Msgs.slice(-80),
  )
  await page8.close()

  // ── 10. 首帧不白屏 + 无自我重载 ─────────────────────────
  // 用户报过「界面一直闪、白屏和有内容交替」。两个根因都在渲染入口：
  //   1) 首帧底色靠 JS 加载后的 CSS 才生效，重载时先涂一帧纯白；
  //   2) Vite HMR 写死独立端口，第二个实例抢不到 WS，客户端反复重连触发整页 reload。
  // 这里一条运行时闸门 + 一条配置闸门，任一回归都会让 verify:ui 变红。
  const viteCfg = fs.readFileSync(path.join(ROOT, 'vite.config.ts'), 'utf8')
  assert(
    'HMR 不写死独立端口（多实例并行时不会互抢 WS 导致整页 reload）',
    !/hmr\s*:\s*\{[^}]*\bport\s*:/.test(viteCfg),
    'vite.config.ts hmr.port',
  )

  const flash = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await flash.addInitScript(`localStorage.setItem('pi-workbench:theme','dark')`)
  await flash.addInitScript(`window.__PI_REPLAY_MODE__ = true; window.__PI_REPLAY_ACTIVE__ = true`)
  await flash.addInitScript(PI_STUB_SCRIPT)
  await flash.addInitScript(() => {
    const key = '__vc_loads'
    sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) ?? 0) + 1))
    const frames = []
    const t0 = performance.now()
    const tick = () => {
      frames.push(getComputedStyle(document.documentElement).backgroundColor)
      if (performance.now() - t0 < 1500) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    window.__vcFrames = frames
  })
  await flash.goto(`http://localhost:${PORT}/#/chat`, { waitUntil: 'commit' })
  await flash.waitForTimeout(1400)
  const flashFrames = await flash.evaluate(() => window.__vcFrames ?? [])
  const whiteFrames = flashFrames.filter((c) => c === 'rgb(255, 255, 255)' || c === 'rgba(0, 0, 0, 0)')
  assert(
    '首帧底色为主题底色（不出现白屏帧）',
    flashFrames.length > 0 && whiteFrames.length === 0,
    `frames=${flashFrames.length} white=${whiteFrames.length} first=${flashFrames[0] ?? 'none'}`,
  )
  const loadsBefore = await flash.evaluate(() => Number(sessionStorage.getItem('__vc_loads')))
  await flash.reload({ waitUntil: 'load' })
  await flash.waitForTimeout(900)
  const loadsAfter = await flash.evaluate(() => Number(sessionStorage.getItem('__vc_loads')))
  const mounted = await flash.locator('.app-shell').count()
  assert(
    '重载一次只加载一次（没有 reload 循环），且挂载后容器有内容',
    loadsBefore === 1 && loadsAfter === 2 && mounted === 1,
    `loads=${loadsBefore}→${loadsAfter} shell=${mounted}`,
  )
  await flash.close()

  // ── 页面壳定律（2026-11-22 用户「一个页面一个页面的样式也要修正」）──
  // 宽屏（>1280+边距）下所有内容页的列边线必须落在同一条竖直线上：
  // 各页壳统一 max-width: var(--page-max) + margin auto + --page-x 内衬
  // （ui-kit .page-inner 口径；旧口径三种——1280 / agent-ops 1100 硬编码 / 不封顶——已统一）。
  const wide = await browser.newPage({ viewport: { width: 1800, height: 950 } })
  await wide.addInitScript(PI_STUB_SCRIPT)
  const shellPages = [
    ['收件箱', '#/inbox', '.inbox-view'],
    ['插件', '#/plugins', '.wd-community'],
    ['能力中心', '#/capabilities', '.wd-market'],
    ['资料库', '#/library', '.wd-library'],
    ['项目', '#/projects', '.wd-p-center'],
    ['本地模型', '#/local-models', '.page-inner'],
    ['项目工作台', '#/projects/p-flow-b', '.pw'],
  ]
  const edges = []
  for (const [name, hash, sel] of shellPages) {
    await wide.goto(`http://localhost:${PORT}/${hash}`, { waitUntil: 'load' })
    await wide.waitForTimeout(500)
    const box = await wide.evaluate((s) => {
      const el = document.querySelector(s)
      if (!el) return null
      const r = el.getBoundingClientRect()
      const cs = getComputedStyle(el)
      // 量壳的 border-box 边线（不含内衬）：所有壳统一 max-width + margin auto，
      // 内衬位置各异（.pw 在子元素 margin，其余在壳 padding）不参与对齐判定。
      return {
        left: Math.round(r.left),
        right: Math.round(r.right),
        capped: cs.maxWidth !== 'none',
      }
    }, sel)
    edges.push({ name, ok: !!box && box.capped, ...box })
  }
  assert(
    '页面壳：七个内容页宽屏下统一封顶 --page-max',
    edges.every((e) => e.ok),
    JSON.stringify(edges.map((e) => `${e.name}:${e.capped ?? 'none'}`)),
  )
  const first = edges[0]
  assert(
    '页面壳：各页内容边线同一条对齐线（≤2px）',
    edges.every((e) => e.ok && Math.abs(e.left - first.left) <= 2 && Math.abs(e.right - first.right) <= 2),
    JSON.stringify(edges.map((e) => `${e.name}:${e.left}→${e.right}`)),
  )
  await wide.close()

  // ── 专家团派遣不再卡住：走 team_dispatch 工具，非 /team 命令 ───────
  // 独立页面：命令通道不产 agent 事件，前端会等 180s；工具调用走正常 agent 轮次。
  const teamPage = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  // scripted 模式：stub 预绑工作目录并记录 pi_send 正文（非 scripted 首次发送要先走弹窗绑目录）
  await teamPage.addInitScript('window.__PI_SCRIPTED__ = true')
  await teamPage.addInitScript(PI_STUB_SCRIPT)
  await teamPage.goto(`http://localhost:${PORT}/#/chat`, { waitUntil: 'load' })
  await teamPage.waitForTimeout(700)
  await teamPage.locator('.hero-input-wrap .cpm-trigger').click()
  await teamPage.waitForTimeout(200)
  await teamPage.locator('.cpm-menu .cpm-row', { hasText: '专家' }).click()
  await teamPage.waitForTimeout(250)
  await teamPage.locator('.cpm-menu .cpm-tab').nth(1).click()
  await teamPage.waitForTimeout(200)
  await teamPage.locator('.cpm-menu .cpm-expert').first().click()
  await teamPage.waitForTimeout(200)
  assert('#86：专家团选中后 chip 回显', (await teamPage.locator('.hero-input-wrap .cpm-chip.team').count()) === 1, '')
  await teamPage.locator('.hero-input-wrap .app-textarea').first().fill('检查当前项目问题')
  await teamPage.locator('.hero-send').click()
  await teamPage.waitForFunction(() => String(window.__PI_STUB__?.lastSent ?? '').length > 0, { timeout: 6000 }).catch(() => {})
  const teamSent = await teamPage.evaluate(() => String(window.__PI_STUB__?.lastSent ?? ''))
  assert('#86：派遣走 team_dispatch 工具指令', teamSent.includes('team_dispatch tool'), teamSent.slice(0, 160))
  assert('#86：不再下发 /team 命令（命令通道无 settled 会卡 180s）', !teamSent.includes('/team dispatch'), teamSent.slice(0, 160))
  await teamPage.close()

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
