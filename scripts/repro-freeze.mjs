#!/usr/bin/env node
/**
 * 卡死复现：模拟用户在落地页 Hero 输入框逐字打字 + 回车，
 * 每步探测 JS 主线程响应性（evaluate 超时 = 主线程被占住），并抓 console/page 错误。
 *
 * 用法：pnpm build && node scripts/repro-freeze.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')
const PORT = 4399

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0])
  let file = path.join(DIST, urlPath === '/' ? 'index.html' : urlPath)
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html')
  res.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream')
  fs.createReadStream(file).pipe(res)
})

await new Promise((r) => server.listen(PORT, r))

const pw = require('playwright-core')
const browser = await pw.chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
const page = await browser.newPage()

const errors = []
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`)
})
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))

/** 主线程响应性探测：超过 timeout 未返回即判定被占住。 */
async function probe(label, timeout = 4000) {
  const t0 = Date.now()
  try {
    await page.evaluate(() => 1 + 1, { timeout })
    console.log(`PROBE OK   ${label}  (${Date.now() - t0}ms)`)
    return true
  } catch {
    console.log(`PROBE FAIL ${label}  主线程 ${timeout}ms 内无响应 —— 卡死复现`)
    return false
  }
}

await page.goto(`http://localhost:${PORT}/#/`, { waitUntil: 'networkidle' })
await page.waitForTimeout(800)

// 落地页输入框：ChatHero 里 AppTextarea 带 class="hero-input"
const input = page.locator('textarea.hero-input')
if ((await input.count()) === 0) {
  console.log('FATAL 未找到落地页输入框 textarea.hero-input')
  await browser.close()
  server.close()
  process.exit(1)
}

await input.click()
await probe('点击输入框后')

// 逐字输入（模拟 keystroke 路径；中文用 insertText 兜底走 input 事件）
const text = '查看这里面的问有哪些'
for (const ch of text) {
  await page.keyboard.insertText(ch)
  await page.waitForTimeout(60)
}
await probe(`逐字输入完成（${text.length} 字）`)

await page.waitForTimeout(1500)
await probe('输入完成后静置 1.5s')

// 回车（合成外）→ 触发 submitHero → dispatchToPi
await page.keyboard.press('Enter')
await probe('按回车后 0ms')
await page.waitForTimeout(1000)
await probe('按回车后 1s')
await page.waitForTimeout(3000)
await probe('按回车后 4s')

console.log('---')
console.log(`console/page 错误 ${errors.length} 条：`)
for (const e of errors.slice(0, 20)) console.log('  ' + e)

await browser.close()
server.close()
