#!/usr/bin/env node
/**
 * 未声明标识符检查（防「漏 import 却编译通过、运行时 ReferenceError」）。
 *
 * 用 vue-tsc 做全项目类型检查，只挑出「名字没解析」这一类错误：
 *   TS2304 Cannot find name
 *   TS2552 Cannot find name ... Did you mean
 *   TS2686 'X' refers to a UMD global
 *   TS2448 Block-scoped variable used before its declaration
 *
 * 这类错误在运行时必然炸（ReferenceError），而 `vite build` 不做作用域校验，
 * 所以单独成门禁。注意别加缓存层：rtk / 任务缓存会返回上一次的结果，
 * 曾因此把「漏 import computed」误判为通过。
 *
 * 用法：
 *   node scripts/check-undefined.mjs           # 报告 + 非零退出
 *   node scripts/check-undefined.mjs --json    # 机器可读
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const BIN = path.join(ROOT, 'node_modules', 'vue-tsc', 'bin', 'vue-tsc.js')
const CODES = new Set(['TS2304', 'TS2552', 'TS2686', 'TS2448'])
const LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/

const result = spawnSync(process.execPath, [BIN, '--noEmit'], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})

const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
const found = []
for (const raw of output.split('\n')) {
  const match = raw.trim().match(LINE)
  if (!match) continue
  const [, file, line, column, code, message] = match
  if (!CODES.has(code)) continue
  found.push({
    file: path.relative(ROOT, path.resolve(ROOT, file)),
    line: Number(line),
    column: Number(column),
    code,
    message,
  })
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(found, null, 2))
  process.exit(found.length ? 1 : 0)
}

if (!found.length) {
  console.log('未声明标识符检查通过：0 处')
  process.exit(0)
}

console.log(`未声明标识符：${found.length} 处`)
const byFile = new Map()
for (const item of found) {
  const list = byFile.get(item.file) ?? []
  list.push(item)
  byFile.set(item.file, list)
}
for (const [file, items] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n${file}（${items.length}）`)
  for (const item of items) console.log(`  ${item.line}:${item.column} ${item.code} ${item.message}`)
}
console.error('\n修复：补齐缺失的 import 后重跑。')
process.exit(1)
