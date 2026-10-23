/**
 * G3 checkpoint 扩展侧单测（node --experimental-strip-types）：
 *   · currentTurnSeq —— 从 marker 目录取最大 turn seq
 *   · backupDestFor —— 绝对路径 → turn 目录内镜像路径（与 Rust mirror_rel 同规则）
 *   · backupEditTarget —— edit/write 放行前备份；first-write-wins；
 *     源不存在（write 新建）/ 无 checkpoint 目录 / 无进行中 turn 均跳过；
 *     任何 IO 失败静默 false（保险丝不是闸门）。
 * 运行：rtk node --experimental-strip-types scripts/test-harness-checkpoint.ts
 */
import {
  currentTurnSeq,
  backupDestFor,
  backupEditTarget,
} from '../src-tauri/extensions/agent-tool-gate.ts'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

let passed = 0
let failed = 0
function assert(cond: boolean, label: string) {
  if (cond) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.log(`  ✗ ${label}`)
  }
}

const root = mkdtempSync(path.join(tmpdir(), 'cp-ext-'))
const cpDir = path.join(root, 'checkpoints')
mkdirSync(cpDir, { recursive: true })

// —— currentTurnSeq ——
assert(currentTurnSeq(cpDir) === null, '无 marker 时返回 null')
writeFileSync(path.join(cpDir, 'turn-1.json'), '{}')
writeFileSync(path.join(cpDir, 'turn-3.json'), '{}')
writeFileSync(path.join(cpDir, 'turn-2.json'), '{}')
writeFileSync(path.join(cpDir, 'notes.txt'), 'x')
assert(currentTurnSeq(cpDir) === 3, '取最大 seq（忽略非 marker 文件）')

// —— backupDestFor ——
assert(
  backupDestFor('/a/b/c.ts', cpDir, 3) === path.join(cpDir, 'turn-3', 'a/b/c.ts'),
  '镜像路径 = turn 目录 + 去前导斜杠的绝对路径',
)

// —— backupEditTarget ——
process.env.PI_CHECKPOINT_DIR = cpDir
const srcFile = path.join(root, 'src', 'a.ts')
mkdirSync(path.dirname(srcFile), { recursive: true })
writeFileSync(srcFile, 'original')

assert(backupEditTarget(srcFile) === true, '首备份成功')
const dest = backupDestFor(srcFile, cpDir, 3)
assert(existsSync(dest), '备份文件落盘')
assert(readFileSync(dest, 'utf8') === 'original', '备份内容 = 原内容')

writeFileSync(srcFile, 'modified')
assert(backupEditTarget(srcFile) === false, '同轮二次编辑跳过（first-write-wins）')
assert(readFileSync(dest, 'utf8') === 'original', '备份不被二次编辑覆盖')

const newFile = path.join(root, 'src', 'brand-new.ts')
assert(backupEditTarget(newFile) === false, 'write 新建文件（源不存在）不备份')
assert(!existsSync(backupDestFor(newFile, cpDir, 3)), '无多余备份文件')

// 无进行中 turn：空目录
const emptyCp = path.join(root, 'empty-cp')
mkdirSync(emptyCp, { recursive: true })
process.env.PI_CHECKPOINT_DIR = emptyCp
assert(backupEditTarget(srcFile) === false, '无 turn marker 时不备份')

// 环境变量缺失
delete process.env.PI_CHECKPOINT_DIR
assert(backupEditTarget(srcFile) === false, '无 PI_CHECKPOINT_DIR 时不备份')

rmSync(root, { recursive: true, force: true })

console.log(`\n[test-harness-checkpoint] ${passed} 通过 / ${failed} 失败`)
process.exit(failed ? 1 : 0)
