#!/usr/bin/env node
/**
 * i18n 覆盖率与 CJK 残留检查。
 *
 * - 覆盖率：源码里 `t('...')` 的 key 是否在 en-US 词典中且有非空译文。
 * - CJK 残留：去掉注释与 t(...) 词条后，源码里仍含中文的位置（未抽取）。
 * - 门禁：默认只报告；加 `--strict` 时残留或未翻译均以非零码退出，供 CI 使用。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC = path.join(ROOT, 'src')
const I18N = path.join(SRC, 'i18n')
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/
const CJK_ALL = /[\u3400-\u9fff\uf900-\ufaff]/g
const strict = process.argv.includes('--strict')

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'i18n' || entry.name === 'node_modules' || entry.name === '__tests__') continue
      walk(full, out)
    } else if (/\.(vue|ts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

function stripComments(source) {
  const keepLines = (block) => block.replace(/[^\n]/g, ' ')
  return source
    .replace(/<!--[\s\S]*?-->/g, keepLines)
    .replace(/\/\*[\s\S]*?\*\//g, keepLines)
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')
}

function extractKeysFromSource(source) {
  const keys = []
  const re = /\bt\(\s*(['"])((?:\\.|(?!\1)[\s\S])*?)\1/g
  let match
  while ((match = re.exec(source))) {
    const key = match[2].replace(/\\(['"\\])/g, '$1')
    if (CJK.test(key)) keys.push(key)
  }
  return keys
}

function moduleName(file) {
  const rel = path.relative(SRC, file).split(path.sep).join('/')
  if (rel.startsWith('views/')) return `view:${rel.slice(6).replace(/\.vue$/, '')}`
  if (rel.startsWith('components/')) return `component:${rel.slice(11).replace(/\.vue$/, '')}`
  if (rel.startsWith('composables/')) return `composable:${rel.slice(12).replace(/\.ts$/, '')}`
  if (rel.startsWith('utils/')) return `util:${rel.slice(6).replace(/\.ts$/, '')}`
  return rel
}

function loadDictionary() {
  const dir = path.join(I18N, 'en-US')
  const messages = new Map()
  const problems = []
  for (const name of fs.readdirSync(dir)) {
    if (name === 'index.ts' || !name.endsWith('.ts')) continue
    const source = fs.readFileSync(path.join(dir, name), 'utf8')
    const re = /^\s{2}'((?:\\.|[^'])*)'\s*:\s*(?:\n\s*)?'((?:\\.|[^'])*)'/gm
    let match
    while ((match = re.exec(source))) {
      const key = match[1].replace(/\\'/g, "'")
      const value = match[2].replace(/\\'/g, "'")
      if (messages.has(key)) problems.push(`重复词条：${key}（${name}）`)
      messages.set(key, value)
      if (/[@|]/.test(value)) problems.push(`词条值含未转义的 @ 或 |：${key}（${name}）`)
    }
  }
  return { messages, problems }
}

function residualReport(files) {
  const perFile = []
  let chars = 0
  let lines = 0
  for (const file of files) {
    const original = fs.readFileSync(file, 'utf8')
    const ignored = new Set(
      original
        .split('\n')
        .map((line, index) => (line.includes('i18n-ignore') ? index : -1))
        .filter((index) => index >= 0),
    )
    const source = stripComments(original)
    // t('中文') 里的 key 是词条本身，不算残留。
    const cleaned = source.replace(/\bt\(\s*(['"])(?:\\.|(?!\1)[\s\S])*?\1/g, 't()')
    const matches = cleaned.match(CJK_ALL)
    if (!matches) continue
    const residualLines = cleaned
      .split('\n')
      .filter((line, index) => CJK.test(line) && !ignored.has(index))
    if (!residualLines.length) continue
    chars += (residualLines.join('\n').match(CJK_ALL) ?? []).length
    lines += residualLines.length
    perFile.push({
      file: path.relative(ROOT, file),
      module: moduleName(file),
      chars: (residualLines.join('\n').match(CJK_ALL) ?? []).length,
      lines: residualLines.length,
    })
  }
  perFile.sort((a, b) => b.chars - a.chars)
  return { chars, lines, perFile }
}

const files = walk(SRC)
const keysByModule = new Map()
for (const file of files) {
  const keys = extractKeysFromSource(fs.readFileSync(file, 'utf8'))
  if (!keys.length) continue
  const mod = moduleName(file)
  const entry = keysByModule.get(mod) ?? { total: 0, keys: new Set() }
  entry.total += keys.length
  for (const key of keys) entry.keys.add(key)
  keysByModule.set(mod, entry)
}

const allKeys = new Set()
for (const entry of keysByModule.values()) for (const key of entry.keys) allKeys.add(key)
// 错误码词条：`src/i18n/errors.ts` 里的中文源文不写成 t('...') 字面量，
// 而是作为值传给 ipcErrorText，因此单独认一遍，避免被误判为孤儿。
const errorSource = fs.readFileSync(path.join(I18N, 'errors.ts'), 'utf8')
for (const match of errorSource.matchAll(/^\s*'[a-z][a-z0-9-]*\/[a-z0-9-]+':\s*'((?:\\'|[^'])*)',$/gm)) {
  const key = match[1].replace(/\\'/g, "'")
  if (CJK.test(key)) allKeys.add(key)
}

const { messages, problems } = loadDictionary()
const translated = [...allKeys].filter((key) => (messages.get(key) ?? '').trim().length > 0)
const missing = [...allKeys].filter((key) => !(messages.get(key) ?? '').trim())
const orphan = [...messages.keys()].filter((key) => !allKeys.has(key))
const residual = residualReport(files)

console.log('i18n 覆盖率报告')
console.log('─'.repeat(60))
console.log(`词条总数（源码去重）：${allKeys.size}`)
console.log(`已翻译：${translated.length}`)
console.log(`未翻译：${missing.length}`)
console.log(
  `覆盖率：${allKeys.size ? ((translated.length / allKeys.size) * 100).toFixed(1) : '0.0'}%`,
)
console.log(`孤儿词条（en 有、源码无）：${orphan.length}`)
console.log(`CJK 残留：${residual.chars} 字符 / ${residual.lines} 行`)
console.log(`涉及文件：${residual.perFile.length}`)

const byModule = [...keysByModule.entries()]
  .map(([mod, entry]) => {
    const done = [...entry.keys].filter((key) => (messages.get(key) ?? '').trim()).length
    return { mod, total: entry.keys.size, done, pct: entry.keys.size ? (done / entry.keys.size) * 100 : 0 }
  })
  .sort((a, b) => a.pct - b.pct || b.total - a.total)

console.log('\n按模块：')
for (const row of byModule) {
  console.log(
    `  ${row.pct.toFixed(0).padStart(3)}%  ${String(row.done).padStart(4)}/${String(row.total).padEnd(4)}  ${row.mod}`,
  )
}

if (residual.perFile.length) {
  console.log('\nCJK 残留最多的文件：')
  for (const row of residual.perFile.slice(0, 15)) {
    console.log(`  ${String(row.chars).padStart(4)}  ${row.file}`)
  }
}

if (missing.length) {
  console.log('\n未翻译词条（前 40 条）：')
  for (const key of missing.slice(0, 40)) console.log(`  - ${key}`)
}

if (orphan.length) {
  console.log('\n孤儿词条（前 40 条）：')
  for (const key of orphan.slice(0, 40)) console.log(`  - ${key}`)
}

if (problems.length) {
  console.log('\n词典问题：')
  for (const problem of problems) console.log(`  ! ${problem}`)
}

const failed = problems.length > 0 || (strict && (residual.chars > 0 || missing.length > 0))
if (failed) {
  console.error('\ni18n check 未通过' + (strict ? '（strict）' : '（词典结构错误）'))
  process.exit(1)
}
console.log('\ni18n check 通过（报告模式）')
