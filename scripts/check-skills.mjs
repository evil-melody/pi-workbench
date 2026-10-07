#!/usr/bin/env node
/**
 * check:skills —— 技能目录格式校验矩阵。
 *
 * 为什么需要它：Pi 遇到畸形 SKILL.md 是**静默跳过**的（不报错、不进清单）。
 * 用户以为「装了却没生效」，排查成本极高。本脚本的职责就是把内核吞掉的错误
 * 在 CI/预提交阶段显式报出来。
 *
 * 规则与 `src-tauri/src/skills.rs::parse_skill_md` 同源。**不要单独改这里**：
 * 改规则必须同时改 Rust 侧，脚本末尾的常量对账会兜住漂移。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 与 skills.rs 的常量对账用；不一致直接失败，避免两边规则悄悄分叉。 */
const NAME_MAX = 64
const DESC_MAX = 1024
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/

const SKILL_MD = 'SKILL.md'

function fail(msg) {
  console.error(`✘ ${msg}`)
  process.exitCode = 1
}

function ok(msg) {
  console.log(`  ✓ ${msg}`)
}

/** 从 Rust 源码里取常量，防止本脚本的规则与内核长期不同步。 */
function readRustConstants() {
  const src = readFileSync('src-tauri/src/skills.rs', 'utf8')
  const grab = (name) => {
    const m = src.match(new RegExp(`const ${name}: usize = (\\d+);`))
    return m ? Number(m[1]) : null
  }
  return { name: grab('NAME_MAX'), desc: grab('DESC_MAX') }
}

function unquote(s) {
  const v = s.trim()
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    return v.slice(1, -1)
  }
  return v
}

/** 复刻 skills.rs::extract_front_matter 的容错范围：只认「首行 --- + 末行 ---」。 */
function frontMatter(text) {
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return null
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') return lines.slice(1, i)
  }
  return null
}

function parse(text) {
  const body = frontMatter(text)
  if (body === null) return { error: '缺少 YAML frontmatter（首行需为 ---）' }
  const fields = new Map()
  for (const raw of body) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('-')) continue
    const i = line.indexOf(':')
    if (i < 0) continue
    const key = line.slice(0, i).trim()
    if (!fields.has(key)) fields.set(key, unquote(line.slice(i + 1)))
  }
  const name = fields.get('name') ?? ''
  if (!name) return { error: 'frontmatter 缺少 name 字段' }
  const description = fields.get('description') ?? ''
  if (!description) {
    return { error: 'frontmatter 缺少 description 字段；Pi 不会加载没有 description 的技能' }
  }
  return { name, description }
}

function validate(text) {
  const parsed = parse(text)
  if (parsed.error) return { error: parsed.error }
  const { name, description } = parsed
  if (name.length > NAME_MAX) return { error: `name 超过 ${NAME_MAX} 字符` }
  if (!NAME_RE.test(name)) {
    return { error: `name 不合法（仅允许小写字母、数字、单连字符分隔）：${name}` }
  }
  if (description.length > DESC_MAX) return { error: `description 超过 ${DESC_MAX} 字符` }
  if (!description.trim()) return { error: 'description 不能为空' }
  return null
}

/** 递归收集 SKILL.md，跳过 node_modules 与隐藏目录。 */
function collectSkills(dir, out = []) {
  if (!existsSync(dir)) return out
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue
    const full = join(dir, entry)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) collectSkills(full, out)
    else if (entry === SKILL_MD) out.push(full)
  }
  return out
}

async function main() {
  const rust = readRustConstants()
  if (rust.name !== NAME_MAX || rust.desc !== DESC_MAX) {
    fail(
      `规则漂移：脚本 NAME_MAX=${NAME_MAX}/DESC_MAX=${DESC_MAX}，` +
        `skills.rs 是 ${rust.name}/${rust.desc}。改规则必须两边同步。`,
    )
    return
  }

  const roots = [
    join(homedir(), '.pi', 'agent', 'skills'),
    join(process.cwd(), '.pi', 'skills'),
  ]
  const found = roots.flatMap((r) => collectSkills(r))
  console.log(`[check:skills] 扫描 ${roots.length} 个目录，命中 ${found.length} 个 SKILL.md`)

  if (!found.length) {
    ok('没有可校验的技能（空通过）')
    return
  }

  let bad = 0
  for (const file of found) {
    const err = validate(readFileSync(file, 'utf8'))
    if (err) {
      bad++
      fail(`${file}\n    ${err.error}`)
    } else {
      ok(file.replace(homedir(), '~'))
    }
  }
  if (bad) {
    console.error(`\n${bad} 个技能不合规。Pi 会静默跳过它们——修好后再试。`)
  }
}

await main()
