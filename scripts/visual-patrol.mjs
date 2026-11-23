#!/usr/bin/env node
/**
 * 全页视觉巡检：注入 IPC 桩（页面有数据），逐路由 × 明暗主题 × 断点截图，
 * 并跑自动缺陷探测（横向溢出、元素出视口、破图、超小字、文字裁切、空壳页、
 * console/page 报错）。产出 .visual-check/patrol/*.png + patrol-report.json。
 *
 * 目的：把「人眼逐页看」变成「机器先报可疑点、人只看报出来的」。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')
const OUT = path.join(ROOT, '.visual-check', 'patrol')
const PORT = 4325
const { findChrome, loadPlaywright, serveDist } = await import('./lib/preview.mjs')
const { PI_STUB_SCRIPT } = await import('./lib/pi-stub.mjs')

const routes = [
  ['#/chat', 'chat'],
  ['#/inbox', 'inbox'],
  ['#/projects', 'projects'],
  ['#/projects/p-flow-b', 'project-workspace'],
  ['#/library', 'library'],
  ['#/library?view=memory', 'memory'],
  ['#/capabilities', 'capabilities-expert'],
  ['#/capabilities?tab=team', 'capabilities-team'],
  ['#/capabilities?tab=market', 'capabilities-market'],
  ['#/capabilities?tab=browser', 'capabilities-browser'],
  ['#/plugins', 'plugins'],
  ['#/local-models', 'local-models'],
  ['#/settings', 'settings'],
  ['#/no-such-page', 'not-found'],
]
const themes = ['light', 'dark']
const viewports = [
  [1440, 900, 'desk'],
  [1024, 768, 'narrow'],
  [390, 844, 'mobile'],
]

// 页内探测。两条实测原则，都是踩过坑换来的：
// 1. 文字宽度用 Range 量真实字形包围盒，不用 scrollWidth——scrollWidth 会把
//    尾部 padding 计入并向上取整，24px 文字塞进 24px 内容盒也会报 4px「溢出」，
//    全是假阳性（实测 .wd-p-row-action：content 24 / text 24，scrollWidth 却 40）。
// 2. overflow:visible 不是裁切，是外溢压邻居；hidden/auto/scroll 且没 ellipsis
//    才是真裁。两者分开报，修法完全不同。
const PROBE = `(() => {
  const out = []
  const vw = document.documentElement.clientWidth
  const de = document.documentElement
  const ox = de.scrollWidth - de.clientWidth
  if (ox > 1) out.push({ type: 'overflowX', detail: 'document 横向溢出 ' + ox + 'px' })
  const scrollable = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p)
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') return true
      if (p.scrollWidth > p.clientWidth + 1) return true
    }
    return false
  }
  const cls = (el) => (el.className.baseVal ?? el.className).toString().trim().split(/\\s+/).slice(0, 4).join('.')
  const rangeW = (el) => {
    const rng = document.createRange()
    rng.selectNodeContents(el)
    return rng.getBoundingClientRect().width
  }
  const nodes = document.querySelectorAll('body *')
  let checked = 0
  for (const el of nodes) {
    const r = el.getBoundingClientRect()
    if (r.width < 8 || r.height < 8) continue
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue
    checked++
    if (checked > 4000) break
    if (r.right > vw + 2 && !scrollable(el)) {
      out.push({ type: 'offscreen', detail: cls(el) + ' 右缘出视口 ' + Math.round(r.right - vw) + 'px' })
    }
    if (el.tagName === 'IMG' && el.complete && el.naturalWidth === 0) {
      out.push({ type: 'brokenImg', detail: el.getAttribute('src')?.slice(0, 80) || 'img' })
    }
    const fsz = parseFloat(cs.fontSize)
    if (fsz > 0 && fsz < 10 && el.textContent.trim().length > 0 && el.children.length === 0) {
      out.push({ type: 'tinyFont', detail: cls(el) + ' font ' + fsz + 'px' })
    }
    // 文字实测：只在叶子文本或纯文本容器上做，父级重复计无意义。
    const hasText = el.textContent.trim().length > 0
    const isTextLeaf = hasText && ![...el.children].some((c) => c.textContent.trim().length > 0)
    if (isTextLeaf) {
      const padL = parseFloat(cs.paddingLeft) || 0
      const padR = parseFloat(cs.paddingRight) || 0
      // inline 盒子（<code> 胶囊默认 inline）的 clientWidth 恒为 0，
      // 只能用 getBoundingClientRect 反推内容盒：border-box 宽减左右 border 与 padding。
      const rect = el.getBoundingClientRect()
      const bl = parseFloat(cs.borderLeftWidth) || 0
      const br = parseFloat(cs.borderRightWidth) || 0
      const contentBox = rect.width - bl - br - padL - padR
      const textW = rangeW(el)
      const over = textW - contentBox
      const clips = cs.overflowX !== 'visible'
      if (over > 1.5) {
        // 无 class 的元素（表格单元、裸 div）靠祖先链定位，否则报告没法落到代码。
        let anc = ''
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
          const c = cls(p)
          if (c) { anc = c; break }
        }
        const label = (cls(el) || (el.tagName.toLowerCase() + (anc ? '<' + anc : ''))) + ' "' + el.textContent.trim().slice(0, 24) + '" text ' + Math.round(textW) + '/box ' + Math.round(contentBox)
        if (clips && cs.textOverflow !== 'ellipsis') {
          out.push({ type: 'textCut', detail: label + ' 被裁 ' + Math.round(over) + 'px（overflow:' + cs.overflowX + ' 无 ellipsis）' })
        } else if (!clips) {
          out.push({ type: 'textSpill', detail: label + ' 外溢 ' + Math.round(over) + 'px' })
        }
      }
    }
  }
  const main = document.querySelector('.app-main, main, #app')
  const textLen = (main?.innerText || '').trim().length
  if (textLen < 24 && !document.querySelector('canvas, img, svg')) {
    out.push({ type: 'blankShell', detail: '主区域近乎空白（' + textLen + ' 字符）' })
  }
  return out
})()`

fs.mkdirSync(OUT, { recursive: true })
const chrome = findChrome()
const { chromium } = loadPlaywright()
const server = (await serveDist(DIST, PORT)).server
const browser = await chromium.launch({ executablePath: chrome, args: ['--disable-gpu'] })

const report = []
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errs = []
page.on('pageerror', (e) => errs.push(`pageerror ${e.message.slice(0, 140)}`))
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('transformCallback') && !m.text().includes("__TAURI_INTERNALS__")) {
    errs.push(`console ${m.text().slice(0, 140)}`)
  }
})
await page.addInitScript(PI_STUB_SCRIPT)

for (const [hash, name] of routes) {
  for (const theme of themes) {
    for (const [w, h, vp] of viewports) {
      await page.setViewportSize({ width: w, height: h })
      await page.goto(`http://localhost:${PORT}/${hash}`, { waitUntil: 'load' })
      await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme)
      await page.waitForTimeout(900)
      const shot = path.join(OUT, `${name}.${theme}.${vp}.png`)
      await page.screenshot({ path: shot })
      const defects = await page.evaluate(PROBE)
      const tagged = defects.map((d) => ({ ...d, route: name, theme, vp }))
      report.push(...tagged)
      const mark = tagged.length ? `✗ ${tagged.length}` : '✓'
      console.log(`${mark} ${name}/${theme}/${vp}${tagged.length ? ' → ' + tagged.map((d) => d.type).join(',') : ''}`)
      errs.length && (report.push({ type: 'jsError', route: name, theme, vp, detail: errs.splice(0).join(' | ') }), console.log('   jsError logged'))
    }
  }
}

const summary = {}
for (const d of report) summary[d.type] = (summary[d.type] || 0) + 1
fs.writeFileSync(path.join(OUT, 'patrol-report.json'), JSON.stringify(report, null, 2))
console.log('---- 汇总 ----')
console.log(Object.keys(summary).length ? JSON.stringify(summary, null, 2) : '无缺陷')
console.log(`截图目录：${OUT}（${routes.length * themes.length * viewports.length} 张）`)
await browser.close()
server.close()
process.exit(0)
