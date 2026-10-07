#!/usr/bin/env node
/**
 * Pi Workbench 的单一入口：拉起 App / 构建 / 全量校验。
 *
 * 设计参考两条业界做法：
 *   1. 脚本分层 —— dev / build / check 各司其职，check 是可组合的校验矩阵；
 *   2. 固定内核版本 —— 内核（Pi）版本必须与清单声明一致，直接失败而非静默降级。
 *      （历史上装错 `pi-number` 圆周率包，表现为"App 能启动但内核无反应"，这里前置拦截。）
 *
 * 用法：node scripts/app-dev.mjs <dev|dev:web|build|check|preflight>
 */
import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import process from 'node:process'

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const MODE = process.argv[2] ?? 'dev'

const MANIFEST = JSON.parse(await readFile(`${ROOT}/package.json`, 'utf8'))
/** 内核版本唯一真源：与 package.json 的 piVersion 一致，升级必须两处同步。 */
const WANTED_PI = MANIFEST.piVersion ?? '0.87.1'
const WANTED_NODE = MANIFEST.engines?.node ?? '>=20'

/**
 * 工具链目录并入 PATH 后再 spawn。
 *
 * `~/.cargo/bin` 通常不在默认 PATH 上：preflight 能通过回退找到 cargo，
 * 但 `pnpm tauri dev` 用的是继承来的 PATH，结果是「preflight 全绿、cargo metadata 却报
 * 找不到命令」——两个检查看到的环境不是同一个，正是这类报错最难定位的地方。
 */
function toolchainEnv() {
  // 让 corepack 在版本不一致时降级为警告而不是直接退出：
  // package.json 声明 pnpm 12.x，而某些机器上 corepack 只会转发已装的 11.x。
  // 这里的 dev/build 不依赖特定 pnpm 次要版本，严格模式只会把「能跑的命令」变成跑不起来。
  const env = { ...process.env, COREPACK_ENABLE_STRICT: '0' }
  const dirs = []
  for (const raw of [...(BIN_FALLBACKS.cargo ?? []), ...(BIN_FALLBACKS.tauri ?? [])]) {
    const dir = raw.replace(/\/[^\/]+$/, '').replace(/\$HOME/, process.env.HOME ?? '')
    if (dirs.includes(dir)) continue
    if (existsSync(dir)) dirs.push(dir)
  }
  if (!dirs.length) return env
  return {
    ...env,
    PATH: [...dirs, env.PATH].filter(Boolean).join(':'),
  }
}

const run = (cmd, args, cwd = ROOT) =>
  new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, stdio: 'inherit', shell: false, env: toolchainEnv() })
    p.on('exit', (code) => resolve(code ?? 1))
  })

const ok = (m) => console.log(`  ✔ ${m}`)
const warn = (m) => console.log(`  ! ${m}`)
const fail = (m) => {
  console.error(`  ✘ ${m}`)
  throw new Error(m)
}

/**
 * 在 PATH 上找命令，找不到再回退到常见安装位置。
 *
 * cargo 常装在 ~/.cargo/bin 而该目录不在默认 PATH 里，此前直接判失败，
 * 用户看到的是「未找到 cargo」而不是真正的修复动作。
 */
/** 不在默认 PATH 上的常见安装位置，找不到命令时按序回退。 */
const BIN_FALLBACKS = {
  cargo: ['$HOME/.cargo/bin/cargo', '/opt/homebrew/bin/cargo'],
  rustc: ['$HOME/.cargo/bin/rustc', '/opt/homebrew/bin/rustc'],
  tauri: ['$HOME/.cargo/bin/tauri', '$HOME/.local/bin/tauri'],
}

function versionOf(bin) {
  const probe = (exe) => {
    try {
      const r = spawnSync(exe, ['--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: false,
      })
      return r.status === 0 && r.stdout ? r.stdout.trim().split('\n')[0] : null
    } catch {
      return null
    }
  }

  const hit = probe(bin)
  if (hit) return hit
  for (const raw of BIN_FALLBACKS[bin] ?? []) {
    const p = raw.replace('$HOME', process.env.HOME ?? '')
    if (existsSync(p)) {
      const v = probe(p)
      if (v) return v
    }
  }
  return null
}

function portFree_(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

/** 前置检查：缺什么直说，不做静默降级（静默降级正是当年 pi-number 事故的成因）。 */
async function preflight({ requireRust = true, requireTauri = false, checkPort = true } = {}) {
  console.log('[preflight] Pi Workbench 环境检查')

  const nodeVer = process.versions.node
  if (Number(nodeVer.split('.')[0]) < 20) fail(`Node 版本过低：当前 ${nodeVer}，要求 ${WANTED_NODE}`)
  ok(`Node ${nodeVer}`)

  // 内核必须是 agent harness，不是同名的 pi-number（圆周率）包。
  const piVer = versionOf('pi')
  if (!piVer) {
    fail(
      `未找到 pi 命令。请安装 agent harness：npm install -g @earendil-works/pi-coding-agent@${WANTED_PI}`
    )
  }
  if (!piVer.includes(WANTED_PI)) {
    fail(
      `pi 版本不匹配：当前 ${piVer}，清单声明 ${WANTED_PI}。\n` +
        `      npm 上的 pi 包是"计算圆周率"的同名包，会让 App 启动但内核无反应。\n` +
        `      正确安装：npm install -g @earendil-works/pi-coding-agent@${WANTED_PI}`
    )
  }
  ok(`pi ${piVer}`)

  if (requireRust) {
    const cargo = versionOf('cargo')
    if (!cargo) {
      fail('未找到 cargo。桌面模式需要 Rust 工具链：https://rustup.rs')
    }
    ok(`cargo ${cargo}`)
  } else {
    warn('跳过 Rust 检查（浏览器模式，内核不可用）')
  }

  if (requireTauri) {
    // 缺失时 pnpm 只会甩一句 command not found，这里给出可直接执行的修复命令。
    const tauriVer = versionOf('tauri')
    if (!tauriVer) {
      fail(
        '未找到 tauri CLI。桌面窗体依赖它：\n' +
          '      npm install -D @tauri-apps/cli   （或用 cargo install tauri-cli --locked）'
      )
    }
    ok(`tauri ${tauriVer}`)
  }

  // 桌面模式下 Vite 由 tauri CLI 托管，上一次实例残留时占用属正常现象，
  // 这里只提醒不阻断；仅独立跑 dev:web 时才把端口当作硬约束。
  if (!(await portFree_(1420))) {
    if (checkPort) fail('端口 1420 被占用。先释放它，或修改 vite.config.ts 的 server.port')
    warn('端口 1420 已被占用（上一次 Vite 可能仍在运行），新实例将复用该端口')
  } else {
    ok('端口 1420 空闲')
  }
}

const TASKS = {
  /** 桌面 App：Tauri + 真 Pi 内核。 */
  async dev() {
    // 端口交由 tauri CLI 托管的 Vite 处理，这里不断言。
    await preflight({ requireRust: true, requireTauri: true, checkPort: false })
    console.log('\n[dev] 编译内核并拉起 Tauri 窗体…')
    console.log('      Vite 开发服务器在 http://localhost:1420/')
    console.log('      窗体关闭或 Ctrl+C 结束本次开发会话。')
    return run('pnpm', ['tauri', 'dev'])
  },

  /** 浏览器开发服务器：只验证 UI 与布局，不验证内核。 */
  async 'dev:web'() {
    await preflight({ requireRust: false })
    console.log('\n[dev:web] 启动浏览器开发服务器…')
    return run('pnpm', ['dev'])
  },

  /** 桌面包构建。 */
  async build() {
    await preflight({ requireRust: true })
    console.log('\n[build] 打包桌面 App…')
    return run('pnpm', ['tauri', 'build'])
  },

  /** 全量校验：环境 → Rust → 前端。对齐上游工具的 check 脚本矩阵。 */
  async check() {
    await preflight({ requireRust: true })
    console.log('\n[check] cargo check')
    if ((await run('cargo', ['check', '--manifest-path', 'src-tauri/Cargo.toml'])) !== 0) return 1
    console.log('\n[check] pnpm build')
    return run('pnpm', ['build'])
  },

  preflight() {
    return preflight({ requireRust: true }).then(() => 0)
  },
}

const task = TASKS[MODE] ?? TASKS.dev
const code = await task()
process.exit(code === 0 ? 0 : 1)
