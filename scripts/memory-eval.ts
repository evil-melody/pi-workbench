/**
 * 记忆召回评测基线（阶段 2）。
 *
 * 固定 25 条记忆 × 4 类查询 = 100 条，覆盖：原文片段 / 关键词 / 标签 / 同义改写。
 * 输出 `eval/memory-recall-100.jsonl` 与词面 Top5 命中率；同义改写一类用于
 * 判断是否值得在下一轮接向量召回，本轮只记录、不承诺达到某条线。
 *
 * 运行：node --experimental-strip-types scripts/memory-eval.ts [--emit]
 */
import { mkdirSync, existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { entryId, scoreOf } from '../src-tauri/extensions/agent-memory.ts'

type Case = { query: string; expect: string; kind: 'verbatim' | 'keyword' | 'tag' | 'paraphrase' }

const TS0 = 1_780_000_000_000
const DAY = 86_400_000

const fixtures: { text: string; tags: string[]; queries: string[] }[] = [
  { text: '用户偏好电报体汇报，结论先行', tags: ['偏好'], queries: ['电报体汇报', '汇报 结论', '偏好', '说话简洁直接'] },
  { text: '不要用感叹号，也不要用表情符号', tags: ['禁忌'], queries: ['不要用感叹号', '感叹号 表情', '禁忌', '别用 emoji'] },
  { text: '长期目标是把工作台做成单机可用的 Agent 宿主', tags: ['长期目标'], queries: ['单机可用的 Agent 宿主', 'Agent 宿主', '长期目标', '想把产品做成桌面智能体平台'] },
  { text: '常用工作方式：先给设计再动代码', tags: ['工作方式'], queries: ['先给设计再动代码', '设计 代码', '工作方式', '动手前先对齐方案'] },
  { text: '数据库连不上时先看 5432 端口与连接池上限', tags: ['排障'], queries: ['5432 端口', '连接池上限', '排障', '数据库连不上怎么办'] },
  { text: 'git 提交前先跑 pnpm typecheck 与 cargo test', tags: ['流程'], queries: ['pnpm typecheck', 'cargo test', '流程', '提交代码前的检查'] },
  { text: '记忆文件位于 .pi/memory/memory.jsonl', tags: ['记忆'], queries: ['memory.jsonl', '.pi/memory', '记忆', '记忆存在哪'] },
  { text: '主动任务调度周期 10 秒，暂停态不执行', tags: ['调度'], queries: ['10 秒', '暂停态不执行', '调度', '定时任务多久检查一次'] },
  { text: '预授权额度按单次运行计，下次运行前可改', tags: ['预授权'], queries: ['单次运行计', '下次运行前可改', '预授权', '额度什么时候生效'] },
  { text: '内核空闲 5 分钟后自动回收，任务到点重拉', tags: ['内核'], queries: ['5 分钟', '自动回收', '内核', '空闲进程会关掉吗'] },
  { text: '资料库 Office 预览上限 12 MiB', tags: ['资料库'], queries: ['12 MiB', 'Office 预览', '资料库', '大文件预览限制'] },
  { text: 'Pi 版本必须与 piVersion 一致，不做静默降级', tags: ['版本'], queries: ['piVersion', '静默降级', '版本', '内核版本对不上会怎样'] },
  { text: '用户偏好中文回复，代码注释也用中文', tags: ['偏好'], queries: ['中文回复', '代码注释', '偏好', '说中文'] },
  { text: '专家角色 current.md 首行必须是 role 注释', tags: ['角色'], queries: ['current.md', 'role 注释', '角色', '自定义角色怎么写'] },
  { text: '技能目录递归扫描 skills/ 与项目 .pi/skills', tags: ['技能'], queries: ['skills/', '.pi/skills', '技能', '技能放哪里'] },
  { text: 'MCP 工具名以 mcp__ 前缀注入', tags: ['连接器'], queries: ['mcp__ 前缀', '工具名注入', '连接器', '外部工具怎么命名'] },
  { text: '窗口关闭默认询问驻留后台或退出', tags: ['驻留'], queries: ['驻留后台', '关闭询问', '驻留', '关窗口会退出吗'] },
  { text: '登录项默认关闭，设置页显式开启', tags: ['启动'], queries: ['登录项', '设置页开启', '启动', '开机自启默认开吗'] },
  { text: '收件箱未读数由后端计算，前端只展示', tags: ['收件箱'], queries: ['未读数', '后端计算', '收件箱', '红点数字哪来的'] },
  { text: '失败重试按 60 秒乘次数退避，上限 3 次', tags: ['重试'], queries: ['60 秒退避', '上限 3 次', '重试', '任务失败会重跑吗'] },
  { text: '项目目录越界的写入动作直接 block', tags: ['安全'], queries: ['越界写入', '直接 block', '安全', '写文件出项目目录'] },
  { text: '向量检索走 LanceDB，只有外壳进程能查', tags: ['向量'], queries: ['LanceDB', '外壳进程', '向量', '语义检索在哪跑'] },
  { text: '删除记忆有 24 小时撤销窗口，到期硬失效', tags: ['记忆'], queries: ['24 小时撤销', '到期硬失效', '记忆', '删错了能恢复吗'] },
  { text: '报告只需要结论与依据，不写过程复盘', tags: ['偏好'], queries: ['结论与依据', '过程复盘', '偏好', '别写复盘'] },
  { text: '本机没有 Ollama，语义打分能力不可用', tags: ['环境'], queries: ['Ollama', '语义打分不可用', '环境', '本机能跑本地模型吗'] },
]

const KIND_ORDER: Case['kind'][] = ['verbatim', 'keyword', 'tag', 'paraphrase']
const cases: Case[] = []
for (const [i, f] of fixtures.entries()) {
  const id = entryId(TS0 + i * DAY, f.text)
  f.queries.forEach((q, j) => cases.push({ query: q, expect: id, kind: KIND_ORDER[j] }))
}

const memories = fixtures.map((f, i) => ({
  id: entryId(TS0 + i * DAY, f.text),
  ts: TS0 + i * DAY,
  text: f.text,
  tags: f.tags,
}))

if (cases.length !== 100) {
  console.error(`用例数应为 100，实际 ${cases.length}`)
  process.exit(1)
}

const evalFile = path.resolve('eval/memory-recall-100.jsonl')
if (!existsSync(evalFile) || process.argv.includes('--emit')) {
  mkdirSync(path.dirname(evalFile), { recursive: true })
  writeFileSync(evalFile, cases.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8')
  console.log(`已写入 ${evalFile}`)
}

const NOW = TS0 + 30 * DAY
const stats: Record<string, { hit: number; total: number }> = {}
for (const c of cases) {
  const top = memories
    .map((m) => ({ m, s: scoreOf(c.query, m, NOW) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 5)
  const ok = top.some((x) => x.m.id === c.expect)
  const s = (stats[c.kind] ??= { hit: 0, total: 0 })
  s.total++
  if (ok) s.hit++
}

let hit = 0
for (const kind of KIND_ORDER) {
  const s = stats[kind]
  hit += s.hit
  console.log(`${kind.padEnd(11)} ${s.hit}/${s.total} = ${((s.hit / s.total) * 100).toFixed(0)}%`)
}
const rate = (hit / cases.length) * 100
console.log(`Top5 命中率 ${hit}/${cases.length} = ${rate.toFixed(1)}%（词面基线，本轮不承诺阈值）`)
