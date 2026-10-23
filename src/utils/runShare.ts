/**
 * 运行记录「分享任务」的 markdown 摘要拼装。
 *
 * 全部是纯函数（时钟/时长格式化只依赖入参，不读全局状态），
 * 便于 vitest 固定输入断言输出，也避免组件里堆字符串拼接。
 */

/** 分享摘要的输入：一条运行记录的最小字段集（RunRecord 的同形子集）。 */
export interface ShareableRun {
  /** 记录标题（后端可能已被 run_meta 的 title 覆盖）。 */
  title: string
  startedAtMs: number | null
  endedAtMs: number | null
  /** 用户下发任务的次数（本域里「一轮」= 一次下发）。 */
  prompts: number
  cwd: string
}

/** 毫秒时长的中文概览。负数 / 非有限值返回空串（调用方决定省不省这一项）。
 *  取整向下（「至少持续了 X」），半分钟级显示「不到 1 分钟」。 */
export function fmtRunDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const min = Math.floor(ms / 60_000)
  if (min < 1) return '不到 1 分钟'
  if (min < 60) return `${min} 分钟`
  const h = Math.floor(min / 60)
  const restMin = min % 60
  if (h < 24) return restMin ? `${h} 小时 ${restMin} 分钟` : `${h} 小时`
  const d = Math.floor(h / 24)
  const restH = h % 24
  return restH ? `${d} 天 ${restH} 小时` : `${d} 天`
}

/** 本地时间 `YYYY-MM-DD HH:mm`（分钟精度，分享摘要不需要秒）。空值返回空串。 */
export function fmtRunClock(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return ''
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 起止时间行：
 * 两端都有 → `A ~ B（约 X）`；只有开始 → `开始于 A`；只有结束 → `结束于 B`；
 * 都没有 → `时间未知`（legacy journal 段没有时间锚点时不撒谎）。
 */
export function fmtRunTimeRange(start: number | null, end: number | null): string {
  const s = fmtRunClock(start)
  const e = fmtRunClock(end)
  if (s && e) {
    const dur = fmtRunDuration((end as number) - (start as number))
    return dur ? `${s} ~ ${e}（约 ${dur}）` : `${s} ~ ${e}`
  }
  if (s) return `开始于 ${s}`
  if (e) return `结束于 ${e}`
  return '时间未知'
}

/**
 * 拼一条运行记录的 markdown 分享摘要（标题 / 起止时间 / 轮数 / cwd / 任务数）。
 * 产出直接进剪贴板，粘到任何支持 markdown 的地方都能读。
 */
export function buildRunShareText(run: ShareableRun): string {
  const title = (run.title ?? '').trim() || '（未命名运行记录）'
  const prompts = Number.isFinite(run.prompts) ? Math.max(0, Math.trunc(run.prompts)) : 0
  return [
    `# ${title}`,
    '',
    `- 起止时间：${fmtRunTimeRange(run.startedAtMs, run.endedAtMs)}`,
    `- 轮数：${prompts} 轮`,
    `- 任务数：${prompts}`,
    `- 工作目录：\`${run.cwd ?? ''}\``,
  ].join('\n')
}
