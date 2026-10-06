/**
 * Pi extension: 技能池 / 共享市场（agent-skill-pool）
 *
 * 把团队沉淀的技能发布到共享池，其它成员一键安装复用。只把
 * 「发布 / 列举 / 安装」对象化为 Pi 工具。
 * 池状态落 `<base>/.pi/skills-pool/<name>/SKILL.md`，与 Rust `agent_skillpool_list` 共用；
 * 安装目标为项目级 `.pi/skills/<name>/`，Pi 内核扫描 `.pi/skills` 后会自动枚举（需重启内核）。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

type ToolResult = { content: string; details?: unknown; terminate?: boolean }

function piHome(): string {
  return process.env.PI_CODING_AGENT_DIR ?? process.cwd()
}
function poolDir(): string {
  return path.join(piHome(), '.pi', 'skills-pool')
}
function projectSkillsDir(): string {
  return path.join(piHome(), '.pi', 'skills')
}

function validName(n: string): boolean {
  // 与本仓 skills 预检一致：小写字母/数字/单连字符，≤ 64，无大写。
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(n) && n.length <= 64
}

function listPool(): { name: string; description: string; path: string }[] {
  if (!existsSync(poolDir())) return []
  return readdirSync(poolDir())
    .filter((n) => existsSync(path.join(poolDir(), n, 'SKILL.md')))
    .map((n) => {
      const body = readFileSync(path.join(poolDir(), n, 'SKILL.md'), 'utf8')
      const m = body.match(/^---\s*\n([\s\S]*?)\n---/)
      let description = ''
      if (m) {
        const dm = m[1].match(/description:\s*(.+)/)
        if (dm) description = dm[1].trim()
      }
      return { name: n, description, path: path.join(poolDir(), n, 'SKILL.md') }
    })
}

export default function (pi: any) {
  pi.registerTool({
    name: 'skill_publish',
    label: '技能发布到市场',
    description: '把当前技能发布到共享技能池，团队其它成员可 skill_pool_install 复用',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名（小写字母/数字/单连字符，≤64）' },
        description: { type: 'string', description: '一句话说明这个技能做什么' },
        body: { type: 'string', description: 'SKILL.md 正文（说明 + 脚本 + 资源）' },
      },
      required: ['name', 'description', 'body'],
      additionalProperties: false,
    },
    execute: async (_id: string, args: any): Promise<ToolResult> => {
      const name = String(args?.name ?? '').trim()
      const description = String(args?.description ?? '').trim()
      const body = String(args?.body ?? '')
      if (!validName(name)) {
        return { content: `技能名 "${name}" 非法：需小写字母/数字/单连字符且 ≤64`, terminate: false }
      }
      if (!description) return { content: 'description 不能为空', terminate: false }
      const dir = path.join(poolDir(), name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        path.join(dir, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`,
        'utf8',
      )
      const count = listPool().length
      return {
        content: `已发布技能 "${name}" 到技能池（共 ${count} 个）`,
        details: { name, total: count, needs_restart: false },
      }
    },
  })

  pi.registerTool({
    name: 'skill_pool_list',
    label: '列举技能池',
    description: '列出技能市场中已发布的全部技能',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    execute: async (): Promise<ToolResult> => {
      const items = listPool()
      if (!items.length) return { content: '技能池为空，先 skill_publish 发布一个', details: { items: [] } }
      const lines = items.map((i, idx) => `${idx + 1}. ${i.name} - ${i.description || '(无描述)'}`)
      return { content: lines.join('\n'), details: { items } }
    },
  })

  pi.registerTool({
    name: 'skill_pool_install',
    label: '从技能池安装',
    description: '把技能池中的某个技能安装到当前项目的 .pi/skills，内核重启后自动枚举',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能池中的技能名' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    execute: async (_id: string, args: any): Promise<ToolResult> => {
      const name = String(args?.name ?? '').trim()
      const src = path.join(poolDir(), name, 'SKILL.md')
      if (!existsSync(src)) {
        return { content: `技能池里没有 "${name}"`, details: { available: listPool().map((i) => i.name) }, terminate: false }
      }
      const destDir = path.join(projectSkillsDir(), name)
      mkdirSync(destDir, { recursive: true })
      // 复制该技能目录下的全部文件，保持脚本/资源相对结构。
      for (const f of readdirSync(path.join(poolDir(), name))) {
        copyFileSync(path.join(poolDir(), name, f), path.join(destDir, f))
      }
      return {
        content: `已安装 "${name}" 到 .pi/skills/${name}，重启内核后生效`,
        details: { name, installed_to: destDir, needs_restart: true },
      }
    },
  })

  pi.registerCommand('skills-market', {
    description: '显示技能池中的技能数量',
    handler: async (_arg: string, ctx: any) => {
      const items = listPool()
      ctx.ui?.notify(`skills-market: ${items.length} 个技能`, 'info')
    },
  })

  try {
    pi.setActiveTools(['skill_publish', 'skill_pool_list', 'skill_pool_install'])
  } catch {
    /* 运行时未就绪则跳过 */
  }
}
