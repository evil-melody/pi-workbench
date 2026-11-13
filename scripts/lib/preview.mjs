/**
 * 浏览器预览的公共启动件：起静态服务、找 Chrome、载 playwright-core。
 *
 * visual-check.mjs 与 simulate-run-chain.mjs 都要「用本机 Chrome 打开 dist 产物」，
 * 这段启动样板抽出来只留一份，避免两处各写一套找浏览器 / 起服务的逻辑。
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

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
export function loadPlaywright() {
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

/** 本机可用 Chrome/Chromium 的可执行文件；找不到返回 null。 */
export function findChrome() {
  return CHROME_CANDIDATES.find((p) => {
    try {
      return fs.statSync(p).isFile()
    } catch {
      return false
    }
  })
}

/** 静态服务 dist 目录，返回 `{ server, url }`。 */
export function serveDist(distDir, port) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0])
    if (p === '/') p = '/index.html'
    const file = path.join(distDir, p)
    // 防目录穿越：解析后必须仍在 dist 内。
    if (!path.resolve(file).startsWith(path.resolve(distDir))) {
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
  return new Promise((r) => server.listen(port, () => r({ server, url: `http://localhost:${port}` })))
}

/**
 * 运行链路图的几何体检：节点不重叠、连线不穿节点、文字不被裁、图不横向溢出。
 *
 * 全用 SVG 的 getBBox 读真实几何（不依赖截图比对），四个计数都为 0 才算可读；
 * visual-check 与 simulate-run-chain 共用一份，避免两套判定标准漂移。
 */
export async function inspectRunGraph(graph) {
  return graph.evaluate((root) => {
    const fmt = (b) => ({ x: b.x, y: b.y, w: b.width, h: b.height })
    const boxes = [...root.querySelectorAll('.rg-node .rg-box')].map((el) => fmt(el.getBBox()))
    const nodes = [...root.querySelectorAll('.rg-node')]
    const bars = [...root.querySelectorAll('.rg-rail, .rg-stub')].map((el) => fmt(el.getBBox()))
    const texts = nodes.flatMap((n) => {
      const box = n.querySelector('.rg-box')
      if (!box) return []
      const b = box.getBBox()
      return [...n.querySelectorAll('text')].map((el) => ({
        w: el.getBBox().width,
        x: Number(el.getAttribute('x') ?? 0),
        limit: b.x + b.width,
      }))
    })

    let overlaps = 0
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]
        const b = boxes[j]
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) overlaps += 1
      }
    }

    // 连线只允许落在节点之间的空隙：与任一节点矩形有正面积交集即算穿线。
    let crossings = 0
    for (const l of bars) {
      for (const b of boxes) {
        const x = Math.max(0, Math.min(l.x + l.w, b.x + b.w) - Math.max(l.x, b.x))
        const y = Math.max(0, Math.min(l.y + l.h, b.y + b.h) - Math.max(l.y, b.y))
        if (x > 0.5 && y > 0.5) crossings += 1
      }
    }

    const clipped = texts.filter((t) => t.x + t.w > t.limit - 1).length
    const overflow = root.scrollWidth - root.clientWidth
    return { nodes: nodes.length, boxes: boxes.length, overlaps, crossings, clipped, overflow }
  })
}

