#!/usr/bin/env node
/**
 * i18n 词条抽取：列出源码里已用 `t('...')` 的中文 key、所在文件与是否已有英文。
 *
 * 用法：
 *   node scripts/i18n-extract.mjs            # 人类可读清单
 *   node scripts/i18n-extract.mjs --json     # JSON，供翻译工单/脚本消费
 *   node scripts/i18n-extract.mjs --missing  # 只列缺英文的词条
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SRC = path.join(ROOT, 'src')
const I18N = path.join(SRC, 'i18n')
const CJK = /[\u3400-\u9fff\uf900-\ufaff]/
const json = process.argv.includes('--json')
const onlyMissing = process.argv.includes('--missing')

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'i18n' || entry.name === 'node_modules') continue
      walk(full, out)
    } else if (/\.(vue|ts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

function loadDictionary() {
  const dir = path.join(I18N, 'en-US')
  const messages = new Map()
  for (const name of fs.readdirSync(dir)) {
    if (name === 'index.ts' || !name.endsWith('.ts')) continue
    const source = fs.readFileSync(path.join(dir, name), 'utf8')
    const re = /^\s{2}'((?:\\.|[^'])*)'\s*:\s*(?:\n\s*)?'((?:\\.|[^'])*)'/gm
    let match
    while ((match = re.exec(source))) {
      messages.set(match[1].replace(/\\'/g, "'"), match[2].replace(/\\'/g, "'"))
    }
  }
  return messages
}

const messages = loadDictionary()
const entries = new Map()
for (const file of walk(SRC)) {
  const source = fs.readFileSync(file, 'utf8')
  const re = /\bt\(\s*(['"])((?:\\.|(?!\1)[\s\S])*?)\1/g
  let match
  while ((match = re.exec(source))) {
    const key = match[2].replace(/\\(['"\\])/g, '$1')
    if (!CJK.test(key)) continue
    const entry = entries.get(key) ?? { key, files: new Set(), translated: false }
    entry.files.add(path.relative(ROOT, file))
    entry.translated = (messages.get(key) ?? '').trim().length > 0
    entries.set(key, entry)
  }
}

let list = [...entries.values()].sort((a, b) => a.key.localeCompare(b.key, 'zh-CN'))
if (onlyMissing) list = list.filter((entry) => !entry.translated)

if (json) {
  console.log(
    JSON.stringify(
      list.map((entry) => ({
        key: entry.key,
        translated: entry.translated,
        files: [...entry.files],
      })),
      null,
      2,
    ),
  )
} else {
  console.log(`词条：${list.length}（缺英文 ${list.filter((entry) => !entry.translated).length}）`)
  for (const entry of list) {
    console.log(`${entry.translated ? '✓' : '·'} ${entry.key}`)
    for (const file of entry.files) console.log(`    ${file}`)
  }
}
