import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 前后端 IPC 契约守卫。
 *
 * 约定：**所有 `#[tauri::command]` 的参数、返回结构，以及扩展工具的参数与
 * 返回值，统一 snake_case**。Tauri 默认把 Rust 的 snake_case 参数暴露成
 * camelCase，返回结构体是否改名取决于 `#[serde(rename_all = ...)]`；两侧
 * 靠手写对齐，一旦写错，失败方式是**静默**的：参数变 `None`、字段读成
 * `undefined`、列表永远走空态。这里把约定固化成测试：
 *
 *   1. `invoke` / `write` 的顶层参数键必须是 snake_case；
 *   2. 多词参数的命令必须显式声明 `rename_all = "snake_case"`；
 *   3. 命令参数名必须是 snake_case；
 *   4. `Serialize` 结构不得声明 `rename_all = "camelCase"`（外部 CLI /
 *      持久化格式除外，见 allowlist）；
 *   5. 扩展工具 `properties` / `details` / `args.*` 键必须是 snake_case；
 *   6. 同名 Rust 结构与 TS 接口字段拼写必须一致；
 *   7. 前端调用到的命令必须真实存在。
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * 刻意保留 camelCase 的结构与位置：
 * - `CodebaseIndexMeta`：解析 codebase-memory-mcp 的输出，格式由外部 CLI 决定；
 * - `LibraryAsset` / `LibraryStore`：`library.json` 持久化格式，改动会让老数据读不出。
 */
const ALLOW_CAMEL_STRUCT = new Set(['CodebaseIndexMeta', 'LibraryAsset', 'LibraryStore'])

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'target', 'dist', '.git'].includes(entry.name)) continue
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, exts, out)
    else if (exts.some((ext) => p.endsWith(ext))) out.push(p)
  }
  return out
}

function camel(s: string): string {
  return s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
}

function rel(p: string): string {
  return path.relative(ROOT, p)
}

interface RustStruct {
  name: string
  file: string
  /** 结构体级改名规则，null 表示默认（字段名原样） */
  renameAll: string | null
  /** 原始字段名 → 实际序列化后的键名 */
  keys: Map<string, string>
}

function parseRustStructs(file: string): RustStruct[] {
  const src = fs.readFileSync(file, 'utf8')
  const out: RustStruct[] = []
  const re = /((?:\s*(?:\/\/[^\n]*\n|#\[[^\]]*\]))*)\s*pub\s+struct\s+(\w+)\s*\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const attrs = m[1]
    if (!/Serialize/.test(attrs)) continue
    const renameAll = /serde\([^)]*rename_all\s*=\s*"([^"]+)"/.exec(attrs)?.[1] ?? null
    // 花括号配平取结构体体
    let i = re.lastIndex - 1
    let depth = 0
    let body = ''
    for (; i < src.length; i++) {
      const c = src[i]
      if (c === '{') {
        depth++
        if (depth === 1) continue
      } else if (c === '}') {
        depth--
        if (depth === 0) break
      }
      if (depth >= 1) body += c
    }
    // 顶层逗号切字段（跳过泛型/嵌套结构）
    const fields: string[] = []
    let d = 0
    let cur = ''
    for (const c of body) {
      if ('<([{'.includes(c)) d++
      else if ('>)]}'.includes(c)) d--
      if (d === 0 && c === ',') {
        fields.push(cur)
        cur = ''
      } else cur += c
    }
    if (cur.trim()) fields.push(cur)

    const keys = new Map<string, string>()
    for (const f of fields) {
      const fm = /\s*pub\s+(\w+)\s*:/.exec(f)
      if (!fm) continue
      const raw = fm[1]
      const fattr = f.slice(0, fm.index)
      const explicit = /serde\([^)]*rename\s*=\s*"([^"]+)"/.exec(fattr)?.[1]
      let key = explicit ?? raw
      if (!explicit && renameAll === 'camelCase') key = camel(raw)
      keys.set(raw, key)
    }
    out.push({ name: m[2], file: rel(file), renameAll, keys })
  }
  return out
}

interface TsInterface {
  name: string
  file: string
  keys: string[]
}

function parseTsInterfaces(file: string): TsInterface[] {
  const src = fs.readFileSync(file, 'utf8')
  const out: TsInterface[] = []
  const re = /(?:export\s+)?(?:interface|type)\s+([A-Z]\w*)\s*(?:=\s*)?\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    let i = re.lastIndex - 1
    let depth = 0
    let body = ''
    for (; i < src.length; i++) {
      const c = src[i]
      if (c === '{') {
        depth++
        if (depth === 1) continue
      } else if (c === '}') {
        depth--
        if (depth === 0) break
      }
      if (depth >= 1) body += c
    }
    const props: string[] = []
    let d = 0
    let cur = ''
    let str: string | null = null
    for (let k = 0; k < body.length; k++) {
      const c = body[k]
      if (str) {
        if (c === '\\') {
          k++
          continue
        }
        if (c === str) str = null
        continue
      }
      if (c === "'" || c === '"' || c === '`') {
        str = c
        continue
      }
      if ('{([<'.includes(c)) d++
      else if ('})]>'.includes(c)) d--
      if (d === 0 && (c === '\n' || c === ';' || c === ',')) {
        if (cur.trim()) props.push(cur)
        cur = ''
      } else cur += c
    }
    if (cur.trim()) props.push(cur)
    const keys: string[] = []
    for (const p of props) {
      const pm = /^\s*(?:readonly\s+)?(\w+)\s*\??\s*:/.exec(p)
      if (pm) keys.push(pm[1])
    }
    out.push({ name: m[1], file: rel(file), keys })
  }
  return out
}

interface RustCommand {
  name: string
  file: string
  /** 命令属性里的改名规则，null 表示 Tauri 默认 camelCase */
  renameAll: string | null
  /** 顶层参数名（原样，可能 snake_case） */
  params: string[]
}

function parseRustCommands(file: string): RustCommand[] {
  const src = fs.readFileSync(file, 'utf8')
  const out: RustCommand[] = []
  const re = /#\[tauri::command[^\]]*\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length
    // 跳过命令属性后面的其他属性 / 注释，找到 fn
    for (;;) {
      const ws = /^\s*/.exec(src.slice(i))?.[0] ?? ''
      i += ws.length
      if (src.startsWith('//', i)) {
        i = src.indexOf('\n', i)
        if (i < 0) break
        continue
      }
      if (src.startsWith('#[', i)) {
        let d = 0
        for (; i < src.length; i++) {
          if (src[i] === '[') d++
          else if (src[i] === ']') {
            d--
            if (d === 0) {
              i++
              break
            }
          }
        }
        continue
      }
      break
    }
    const head = /^(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*\(/.exec(src.slice(i))
    if (!head) continue
    let p = i + head[0].length
    let depth = 1
    let sig = ''
    for (; p < src.length && depth > 0; p++) {
      const c = src[p]
      if (c === '(') depth++
      else if (c === ')') depth--
      if (depth > 0) sig += c
    }
    const params: string[] = []
    let d = 0
    let cur = ''
    for (const c of sig) {
      if ('<([{'.includes(c)) d++
      else if ('>)]}'.includes(c)) d--
      if (d === 0 && c === ',') {
        params.push(cur)
        cur = ''
      } else cur += c
    }
    if (cur.trim()) params.push(cur)
    out.push({
      name: head[1],
      file: rel(file),
      renameAll: /rename_all\s*=\s*"([^"]+)"/.exec(m[0])?.[1] ?? null,
      params: params
        .map((x) => x.split(':')[0].trim().replace(/^mut\s+/, ''))
        .filter((x) => /^[A-Za-z_]\w*$/.test(x))
        .filter((x) => !['app', 'state', 'pi', 'mcp', 'gov', '_app'].includes(x)),
    })
  }
  return out
}

interface InvokeCall {
  cmd: string
  file: string
  line: number
  keys: string[]
}

/** 顶层键：只取对象字面量第一层，跳过字符串与嵌套结构。 */
function topLevelKeys(literal: string): string[] {
  const keys: string[] = []
  let depth = 0
  let cur = ''
  let str: string | null = null
  for (let i = 0; i < literal.length; i++) {
    const c = literal[i]
    if (str) {
      if (c === '\\') {
        i++
        continue
      }
      if (c === str) str = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      str = c
      continue
    }
    if ('{([<'.includes(c)) {
      depth++
      if (depth === 1) continue
    } else if ('})]>'.includes(c)) {
      depth--
      continue
    }
    if (depth === 1 && c === ',') {
      const k = cur.trim().split(':')[0].trim()
      if (k) keys.push(k)
      cur = ''
      continue
    }
    if (depth >= 1) cur += c
  }
  const k = cur.trim().split(':')[0].trim()
  if (k) keys.push(k)
  return keys.filter((k) => /^[\w$]+$/.test(k))
}

function parseInvokeCalls(file: string): InvokeCall[] {
  const src = fs.readFileSync(file, 'utf8')
  const out: InvokeCall[] = []
  // invoke(...) 与 useAgentOps 的 write(...) 包装；read(...) 第二参是浏览器兜底值，不算 IPC 参数。
  const re = /\b(invoke|write)\s*(?:<[^<>]*(?:<[^<>]*>[^<>]*)*>)?\s*\(\s*(['"`])([\w_]+)\2/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const cmd = m[3]
    let i = re.lastIndex
    const sep = /^\s*,\s*/.exec(src.slice(i))
    if (!sep) continue
    i += sep[0].length
    if (src[i] !== '{') continue
    let depth = 0
    let j = i
    let str: string | null = null
    for (; j < src.length; j++) {
      const c = src[j]
      if (str) {
        if (c === '\\') {
          j++
          continue
        }
        if (c === str) str = null
        continue
      }
      if (c === "'" || c === '"' || c === '`') {
        str = c
        continue
      }
      if ('{([<'.includes(c)) depth++
      else if ('})]>'.includes(c)) {
        depth--
        if (depth === 0) break
      }
    }
    out.push({
      cmd,
      file: rel(file),
      line: src.slice(0, m.index).split('\n').length,
      keys: topLevelKeys(src.slice(i, j + 1)),
    })
  }
  return out
}

/** 取 `key: { ... }` 的对象体，花括号配平。 */
function objectBlocks(src: string, key: string): string[] {
  const out: string[] = []
  const re = new RegExp(`\\b${key}\\s*:\\s*\\{`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length - 1
    let depth = 0
    let body = ''
    for (; i < src.length; i++) {
      const c = src[i]
      if (c === '{') {
        depth++
        if (depth === 1) continue
      } else if (c === '}') {
        depth--
        if (depth === 0) break
      }
      if (depth >= 1) body += c
    }
    out.push(body)
  }
  return out
}

const extensionSources = walk(path.join(ROOT, 'src-tauri/extensions'), ['.ts'])

interface ExtKey {
  file: string
  where: string
  key: string
}

/** 扩展工具对模型暴露的键：schema `properties`、返回 `details`、运行期 `args.*`。 */
const extensionKeys: ExtKey[] = extensionSources.flatMap((file) => {
  const src = fs.readFileSync(file, 'utf8')
  const rows: ExtKey[] = []
  for (const block of objectBlocks(src, 'properties')) {
    for (const key of topLevelKeys(`{${block}}`)) rows.push({ file: path.basename(file), where: 'properties', key })
  }
  for (const block of objectBlocks(src, 'details')) {
    for (const key of topLevelKeys(`{${block}}`)) rows.push({ file: path.basename(file), where: 'details', key })
  }
  const access = /\bargs\?*\.([A-Za-z_]\w*)/g
  let m: RegExpExecArray | null
  while ((m = access.exec(src))) rows.push({ file: path.basename(file), where: 'args', key: m[1] })
  return rows
})

const rustSources = walk(path.join(ROOT, 'src-tauri/src'), ['.rs'])
const tsSources = walk(path.join(ROOT, 'src'), ['.ts', '.vue'])
const commands = rustSources.flatMap(parseRustCommands)
const structs = rustSources.flatMap(parseRustStructs)
const interfaces = tsSources.flatMap(parseTsInterfaces)
const calls = tsSources.flatMap(parseInvokeCalls)

describe('IPC 契约', () => {
  it('invoke/write 的顶层参数键必须是 snake_case', () => {
    const bad = calls
      .map((c) => ({ ...c, bad: c.keys.filter((k) => /[A-Z]/.test(k)) }))
      .filter((c) => c.bad.length > 0)
      .map((c) => `${c.file}:${c.line} ${c.cmd} → ${c.bad.join(', ')}`)
    expect(bad, `IPC 参数统一 snake_case，camelCase 键会被当成未传：\n${bad.join('\n')}`).toEqual([])
  })

  it('命令参数名必须是 snake_case', () => {
    const bad = commands
      .flatMap((c) => c.params.filter((p) => /[A-Z]/.test(p)).map((p) => `${c.file} ${c.name}(${p})`))
    expect(bad, `命令参数必须 snake_case：\n${bad.join('\n')}`).toEqual([])
  })

  it('多词参数的命令必须声明 rename_all = "snake_case"', () => {
    const bad = commands
      .filter((c) => c.params.some((p) => p.includes('_')) && c.renameAll !== 'snake_case')
      .map((c) => `${c.file} ${c.name}(${c.params.join(', ')})`)
    expect(bad, `Tauri 默认把 snake_case 参数暴露成 camelCase，必须显式声明：\n${bad.join('\n')}`).toEqual([])
  })

  it('Serialize 结构不得声明 rename_all = "camelCase"', () => {
    const bad = structs
      .filter((s) => s.renameAll === 'camelCase' && !ALLOW_CAMEL_STRUCT.has(s.name))
      .map((s) => `${s.file} ${s.name}`)
    expect(bad, `IPC 返回结构统一 snake_case；确属外部格式请加入 allowlist：\n${bad.join('\n')}`).toEqual([])
  })

  it('扩展工具参数与返回值必须是 snake_case', () => {
    const bad = extensionKeys
      .filter((x) => /[A-Z]/.test(x.key))
      .map((x) => `${x.file} ${x.where}.${x.key}`)
    expect(bad, `扩展工具的 properties / details / args 统一 snake_case：\n${bad.join('\n')}`).toEqual([])
  })

  it('invoke 参数键都对应 Rust 命令参数', () => {
    const byName = new Map(commands.map((c) => [c.name, new Set(c.params)]))
    const bad = calls
      .filter((c) => byName.has(c.cmd))
      .flatMap((c) =>
        c.keys.filter((k) => !byName.get(c.cmd)!.has(k)).map((k) => `${c.file}:${c.line} ${c.cmd}(${k})`),
      )
    expect(bad, `参数键拼写必须与 Rust 命令签名一致，否则后端收不到：\n${bad.join('\n')}`).toEqual([])
  })

  it('前端调用的命令都存在于 Rust 侧', () => {
    const known = new Set(commands.map((c) => c.name))
    const unknown = [...new Set(calls.map((c) => c.cmd))].filter((cmd) => !known.has(cmd))
    expect(unknown, `未找到 #[tauri::command]：${unknown.join(', ')}`).toEqual([])
  })

  it('同名 Rust 结构与 TS 接口字段拼写一致', () => {
    const byName = new Map<string, RustStruct[]>()
    for (const s of structs) {
      const list = byName.get(s.name) ?? []
      list.push(s)
      byName.set(s.name, list)
    }
    const problems: string[] = []
    for (const iface of interfaces) {
      const candidates = byName.get(iface.name) ?? []
      for (const rs of candidates) {
        const effective = new Set(rs.keys.values())
        for (const tk of iface.keys) {
          if (effective.has(tk)) continue
          for (const [raw, key] of rs.keys) {
            // TS 读的是某个真实字段的另一种拼写（snake ↔ camel），但后端实际发的不是它。
            if (key !== tk && (raw === tk || camel(raw) === tk)) {
              problems.push(`${iface.name}: ${rs.file} 发 "${key}"，${iface.file} 读 "${tk}"`)
              break
            }
          }
        }
      }
    }
    expect(problems, `字段名不一致会导致 undefined / 空列表：\n${problems.join('\n')}`).toEqual([])
  })
})
