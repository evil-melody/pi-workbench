/**
 * Pi extension: 浏览器会话（agent-browser-session）
 *
 * 无头 Chromium 自动化、截图、远程浏览等能力的「意图 + 能力探测 + 轻量操作」层。
 * 重渲染复用 Tauri `browser` 模块 + AgentBrowserPane，本扩展不重造 CDP：
 *   · browser_open       打开用户真实浏览器（桌面 agent 友好的外部跳转）
 *   · browser_fetch      抓取页面 HTML（Node fetch，无 JS 渲染）
 *   · browser_screenshot 探测本机 chromium，命中则无头截图落盘，否则如实报能力不可用
 * 状态落 `<base>/.pi/browser/session.json`，与 Rust `agent_browser_status` 共用。
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

type ToolResult = { content: string; details?: unknown; terminate?: boolean }

function piHome(): string {
  return process.env.PI_CODING_AGENT_DIR ?? process.cwd()
}
function browserDir(): string {
  return path.join(piHome(), '.pi', 'browser')
}

/** 探测本机是否有可用的 chromium / chrome 二进制。 */
function findChromium(): string | null {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'chromium',
    'chromium-browser',
    'google-chrome',
    'google-chrome-stable',
  ]
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' })
      return c
    } catch {
      /* 该候选不存在或非可执行，继续 */
    }
  }
  return null
}

function openInUserBrowser(url: string): string {
  const platform = process.platform
  try {
    if (platform === 'darwin') execFileSync('open', [url], { stdio: 'ignore' })
    else if (platform === 'win32') execFileSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' })
    else execFileSync('xdg-open', [url], { stdio: 'ignore' })
    return `已在系统默认浏览器打开 ${url}`
  } catch {
    return `无法打开系统浏览器，请手动访问 ${url}`
  }
}

function writeSession(url: string, extra: Record<string, unknown>) {
  mkdirSync(browserDir(), { recursive: true })
  writeFileSync(
    path.join(browserDir(), 'session.json'),
    JSON.stringify({ url, at: Date.now(), ...extra }, null, 2),
    'utf8',
  )
}

export default function (pi: any) {
  pi.registerTool({
    name: 'browser_open',
    label: '浏览器打开网页',
    description: '在用户真实浏览器中打开一个网址（桌面 agent 的外部跳转）',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打开的网址' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    execute: async (_id: string, args: any): Promise<ToolResult> => {
      const url = String(args?.url ?? '').trim()
      if (!/^https?:\/\//i.test(url)) {
        return { content: `url 需以 http(s):// 开头：${url}`, terminate: false }
      }
      const msg = openInUserBrowser(url)
      writeSession(url, { method: 'open' })
      return { content: msg, details: { url } }
    },
  })

  pi.registerTool({
    name: 'browser_fetch',
    label: '浏览器抓取页面',
    description: '抓取网页 HTML 正文（HTTP GET，不做 JS 渲染），用于读取公开页面内容',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '目标网址' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    execute: async (_id: string, args: any): Promise<ToolResult> => {
      const url = String(args?.url ?? '').trim()
      if (!/^https?:\/\//i.test(url)) {
        return { content: `url 需以 http(s):// 开头：${url}`, terminate: false }
      }
      try {
        const resp = await fetch(url, { redirect: 'follow' })
        const text = await resp.text()
        const truncated = text.length > 20000 ? text.slice(0, 20000) + '\n…(已截断 20K)' : text
        writeSession(url, { method: 'fetch', status: resp.status })
        return {
          content: `HTTP ${resp.status}\n${truncated}`,
          details: { url, status: resp.status, bytes: text.length },
        }
      } catch (e: any) {
        return { content: `抓取失败：${String(e?.message ?? e)}`, terminate: false }
      }
    },
  })

  pi.registerTool({
    name: 'browser_screenshot',
    label: '浏览器截图',
    description: '用本机 chromium 无头截图（需本机有 chromium/chrome；否则如实报能力不可用）',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要截图的网址' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    execute: async (_id: string, args: any): Promise<ToolResult> => {
      const url = String(args?.url ?? '').trim()
      if (!/^https?:\/\//i.test(url)) {
        return { content: `url 需以 http(s):// 开头：${url}`, terminate: false }
      }
      const bin = findChromium()
      if (!bin) {
        return {
          content:
            '本机未探测到 chromium/chrome，无法无头截图。可安装 Chromium 后重试，或在 Tauri 浏览器面板（远程浏览）里手动截图。',
          details: { available: false },
          terminate: false,
        }
      }
      mkdirSync(browserDir(), { recursive: true })
      const out = path.join(browserDir(), `shot-${Date.now()}.png`)
      const r = spawnSync(bin, [
        '--headless',
        '--disable-gpu',
        '--no-sandbox',
        '--hide-scrollbars',
        `--window-size=1280,800`,
        `--screenshot=${out}`,
        url,
      ])
      if (r.status !== 0 || !existsSync(out)) {
        return {
          content: `截图失败（chromium 退出码 ${r.status}）：stderr=${String(r.stderr).slice(0, 300)}`,
          details: { available: true, ok: false },
          terminate: false,
        }
      }
      const size = readFileSync(out).length
      writeSession(url, { method: 'screenshot', shot: out, bytes: size })
      return {
        content: `已截图到 ${out}（${size} 字节）`,
        details: { url, shot: out, bytes: size },
      }
    },
  })

  pi.registerCommand('browser', {
    description: '显示浏览器能力状态',
    handler: async (_arg: string, ctx: any) => {
      const has = findChromium() !== null
      ctx.ui?.notify(`browser: chromium=${has ? 'available' : 'missing'}`, 'info')
    },
  })

  try {
    pi.setActiveTools(['browser_open', 'browser_fetch', 'browser_screenshot'])
  } catch {
    /* 运行时未就绪则跳过 */
  }
}
