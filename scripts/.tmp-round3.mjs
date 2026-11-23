#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')
const OUT = path.join(ROOT, '.visual-check')
const PORT = 4399
const { findChrome, loadPlaywright, serveDist } = await import('./lib/preview.mjs')
const { PI_STUB_SCRIPT: STUB } = await import('./lib/pi-stub.mjs')
const chrome = findChrome()
if (!chrome) { console.error('NO_CHROME'); process.exit(2) }
const { chromium } = loadPlaywright()
fs.mkdirSync(OUT, { recursive: true })
const { server } = await serveDist(DIST, PORT)
const browser = await chromium.launch({ executablePath: chrome, args: ['--disable-gpu'] })
async function newPage({ viewport = { width: 1440, height: 900 }, dark = false, replay = false } = {}) {
  const p = await browser.newPage({ viewport })
  if (dark) await p.addInitScript(`localStorage.setItem('pi-workbench:theme','dark')`)
  if (replay) await p.addInitScript(`window.__PI_REPLAY_MODE__=true;window.__PI_REPLAY_ACTIVE__=true`)
  await p.addInitScript(STUB)
  return p
}
async function go(p, hash, wait = 950) {
  await p.goto(`http://localhost:${PORT}/${hash}`, { waitUntil: 'load' })
  await p.waitForTimeout(wait)
}
async function shot(p, name) {
  await p.screenshot({ path: path.join(OUT, `round3-${name}.png`), animations: 'disabled' })
  console.log('OK shot', name)
}
const LONG = '超长文本溢出验证'.repeat(9)
try {
  const a = await newPage({ dark: true })
  for (const [n, h] of [
    ['A1-hero-dark','#/chat'],['A2-capabilities-dark','#/capabilities'],
    ['A3-settings-dark','#/settings'],['A4-projects-dark','#/projects'],
    ['A5-library-dark','#/library'],
  ]) { await go(a,h); await shot(a,n) }
  await a.close()
  const a6 = await newPage({ dark: true, replay: true })
  await go(a6,'#/chat',1300); await shot(a6,'A6-chat-dark'); await a6.close()

  for (const w of [768,1024]) {
    const b = await newPage({ viewport:{width:w,height:900}, replay:true })
    for (const [n,h] of [
      [`B1-chat-${w}`,'#/chat'],[`B2-settings-${w}`,'#/settings'],
      [`B3-capabilities-${w}`,'#/capabilities'],
    ]) { await go(b,h); await shot(b,n) }
    await b.close()
  }

  const c1 = await newPage()
  await go(c1,'#/settings')
  const r1 = await c1.evaluate((long) => {
    const pick = [...document.querySelectorAll('[class*="name"],[class*="title"]')]
      .filter(e=>e.getClientRects().length && ((e.textContent||'').trim().length>=2) && e.children.length===0)
      .sort((x,y)=>(y.className.includes('name')?1:0)-(x.className.includes('name')?1:0))
    const el = pick[0]; if(!el) return null
    const before=(el.textContent||'').trim()
    el.textContent=long; el.style.whiteSpace='nowrap'
    return {cls:el.className,before,len:el.textContent.length}
  }, LONG)
  console.log('C1', JSON.stringify(r1))
  await c1.waitForTimeout(80); await shot(c1,'C1-settings-longtext'); await c1.close()

  const c2 = await newPage()
  await go(c2,'#/capabilities?tab=skill')
  const r2 = await c2.evaluate((long) => {
    const pick = [...document.querySelectorAll('[class*="name"],[class*="title"]')]
      .filter(e=>e.getClientRects().length && ((e.textContent||'').trim().length>=2) && e.children.length===0)
      .sort((x,y)=>(y.className.includes('name')?1:0)-(x.className.includes('name')?1:0))
    const el = pick[0]; if(!el) return null
    const before=(el.textContent||'').trim()
    el.textContent=long; el.style.whiteSpace='nowrap'
    return {cls:el.className,before,len:el.textContent.length}
  }, LONG)
  console.log('C2', JSON.stringify(r2))
  await c2.waitForTimeout(80); await shot(c2,'C2-capabilities-longtext'); await c2.close()
} catch(e) { console.error('ERR',e) } finally {
  await browser.close(); await new Promise(r=>server.close(r))
}
