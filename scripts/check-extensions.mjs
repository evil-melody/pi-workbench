#!/usr/bin/env node
/**
 * check:extensions —— Pi extension 的 API 兼容性与重复注册校验。
 *
 * 规则来自两个真实踩过的坑（都在这个仓库里发生过）：
 *   1. `registerTool("name", {...})` 旧写法会让 Pi 报 “Tool \"undefined\" must define
 *      an object parameter schema”，因为 Pi 2.x 的 ToolDefinition 是单对象注册。
 *   2. 同一个对象字面量里写重复的键（如 description 写了两遍），后者静默覆盖前者，
 *      直到运行时才发现注册进去的是错的那个。
 *
 * 复用仓库已有的 `typescript` 依赖做语法层解析，不额外引新包。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const DIR = 'src-tauri/extensions'

/** `registerX` 调用的入参 → 该 register 的语义类型。 */
const REGISTER = {
  registerTool: 'tool',
  registerCommand: 'command',
}

function fail(msg) {
  console.error(`✘ ${msg}`)
  process.exitCode = 1
}

function ok(msg) {
  console.log(`  ✓ ${msg}`)
}

/** 收集 `foo({...})` 这类调用的第一个对象参数。 */
function objectArguments(node) {
  const out = []
  const walk = (n) => {
    if (ts.isCallExpression(n)) {
      const arg = n.arguments[0]
      if (arg && ts.isObjectLiteralExpression(arg)) out.push(arg)
    }
    ts.forEachChild(n, walk)
  }
  walk(node)
  return out
}

/** 对象字面量里重复出现的属性名（含字符串字面量键）。 */
function duplicateKeys(obj) {
  const counts = new Map()
  for (const p of obj.properties) {
    const name =
      ts.isIdentifier(p.name) || ts.isPrivateIdentifier(p.name)
        ? p.name.text
        : ts.isStringLiteral(p.name)
          ? p.name.text
          : null
    if (name === null) continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts].filter(([, n]) => n > 1).map(([k]) => k)
}

/** 取字符串字面量参数，取不到返回 null。 */
function stringLiteralAt(node, index) {
  const arg = node.arguments[index]
  return arg && ts.isStringLiteralLike(arg) ? arg.text : null
}

/** 取对象属性上的值节点。 */
function propertyValue(obj, key) {
  if (!obj || !ts.isObjectLiteralExpression(obj)) return undefined
  for (const p of obj.properties) {
    if (p.name && ts.isIdentifier(p.name) && p.name.text === key) return p.initializer
  }
  return undefined
}

function isFunctionLike(node) {
  return !!node && (ts.isFunctionExpression(node) || ts.isArrowFunction(node))
}

function registerTool(obj, where) {
  const name = propertyValue(obj, 'name')
  if (!name || !ts.isStringLiteralLike(name)) return fail(`${where}: registerTool 缺少 name 字符串字面量`)
  const label = name.text
  const params = propertyValue(obj, 'parameters')
  if (!params || !ts.isObjectLiteralExpression(params)) {
    return fail(`${where}: 工具「${label}」缺少 parameters 对象（Pi 2.x 要求单对象注册）`)
  }
  const type = propertyValue(params, 'type')
  if (!type || !ts.isStringLiteralLike(type) || type.text !== 'object') {
    return fail(`${where}: 工具「${label}」的 parameters.type 必须是 "object"`)
  }
  const execute = propertyValue(obj, 'execute')
  if (!isFunctionLike(execute)) {
    return fail(`${where}: 工具「${label}」缺少 execute 函数`)
  }
  return label
}

function registerCommand(obj, where, sink) {
  if (!obj || !ts.isObjectLiteralExpression(obj)) {
    fail(`${where}: registerCommand 的第二个参数必须是对象字面量`)
    return
  }
  const handler = propertyValue(obj, 'handler')
  if (!isFunctionLike(handler)) {
    fail(`${where}: 命令「${sink[sink.length - 1]}」缺少 handler 函数`)
    return
  }
}

async function main() {
  let files
  try {
    files = readdirSync(DIR).filter((f) => f.endsWith('.ts'))
  } catch {
    fail(`读不到扩展目录 ${DIR}`)
    return
  }
  if (!files.length) {
    fail(`${DIR} 里没有 .ts 扩展`)
    return
  }

  const toolNames = []
  const commandNames = []
  const defaultExports = []
  let bad = 0

  for (const file of files) {
    const path = join(DIR, file)
    const text = readFileSync(path, 'utf8')
    const sf = ts.createSourceFile(path, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS)

    if (sf.statements.length === 0) {
      fail(`${path}: 解析失败`)
      bad++
      continue
    }

    let hasDefaultExport = false
    for (const st of sf.statements) {
      // `export default function (pi) {}` / `export default (pi) => {}`
      if (
        (ts.isFunctionDeclaration(st) || ts.isFunctionExpression(st)) &&
        (st.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
      ) {
        hasDefaultExport = true
      }
      if (ts.isExportAssignment(st) && st.isExportEquals === false && ts.isFunctionLike(st.expression)) {
        hasDefaultExport = true
      }
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          const init = d.initializer
          if (
            d.name.getText(sf) === 'default' &&
            (ts.isFunctionExpression(init) || ts.isArrowFunction(init))
          ) {
            hasDefaultExport = true
          }
        }
      }
    }
    if (!hasDefaultExport) {
      fail(`${path}: 缺少 export default function (pi: ExtensionAPI) 形式的默认导出`)
      bad++
      continue
    }
    defaultExports.push(file)

    for (const obj of objectArguments(sf)) {
      for (const key of duplicateKeys(obj)) {
        fail(`${path}: 对象字面量里 ${key} 重复定义（后者会静默覆盖前者）`)
        bad++
      }
    }

    const walk = (n) => {
      if (ts.isCallExpression(n)) {
        const callee = n.expression
        if (ts.isPropertyAccessExpression(callee)) {
          const kind = REGISTER[callee.name.text]
          if (kind) {
            // 行号要按 SF 的行表换算，直接加偏移会给出对不上的位置。
            const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
            const where = `${path}:${line}`
            // 签名差异：registerTool({...}) 单参数，registerCommand("x", {...}) 双参数。
            const isCommand = kind === 'command'
            const obj = isCommand ? n.arguments[1] : n.arguments[0]
            if (isCommand) {
              const name = stringLiteralAt(n, 0)
              if (!name) {
                fail(`${where}: registerCommand 缺少命令名字面量`)
                bad++
                return
              }
              commandNames.push(name)
            }
            if (!obj || !ts.isObjectLiteralExpression(obj)) {
              fail(`${where}: ${callee.name.text} 必须传一个对象字面量`)
              bad++
            } else if (isCommand) {
              registerCommand(obj, where, commandNames)
            } else {
              const label = registerTool(obj, where)
              if (typeof label !== 'string') bad++
              else if (toolNames.includes(label)) {
                fail(`${where}: 工具「${label}」重复注册`)
                bad++
              } else toolNames.push(label)
            }
          }
          // setActiveTools 传空数组会把内置工具全部停掉，这是文档里明确警告过的语义。
          if (callee.name.text === 'setActiveTools') {
            const arg = n.arguments[0]
            if (arg && ts.isArrayLiteralExpression(arg)) {
              const literals = arg.elements.filter((e) => ts.isStringLiteralLike(e)).length
              if (literals === 0) {
                fail(`${path}: setActiveTools([]) 的语义是「只激活列出的工具」，` + `会把内置工具全部停掉`)
                bad++
              }
            }
          }
        }
      }
      ts.forEachChild(n, walk)
    }
    walk(sf)
  }

  for (const f of defaultExports) ok(`${f} 默认导出完好`)
  if (!bad && toolNames.length) ok(`工具 ${toolNames.length} 个：${toolNames.join('、')}`)
  if (!bad && commandNames.length) ok(`命令 ${commandNames.length} 个：${commandNames.join('、')}`)
  if (process.exitCode) return
  console.log(`\n[check:extensions] ${files.length} 个扩展通过`)
}

await main()
