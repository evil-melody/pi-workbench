/** Worktree 工作区页（并行 agent 执行面）的英文文案。 */
export const worktrees: Record<string, string> = {
  '并行工作区': 'Worktrees',
  '并行 agent 工作区：一分支一 worktree 一会话，改动互不干扰':
    'Parallel agent workspaces: one branch, one worktree, one session — changes never collide',
  '新分支名，如 feat-auth': 'New branch, e.g. feat-auth',
  '创建 worktree': 'Create worktree',
  '创建中…': 'Creating…',
  '当前活动项目没有绑定目录。先在「项目」里为项目设置仓库路径。':
    'The active project has no directory bound. Set a repo path for it under Projects first.',
  '已创建 worktree：{branch}': 'Worktree created: {branch}',
  '{branch} 有未提交改动，强制删除？':
    '{branch} has uncommitted changes. Force delete?',
  '合并到 {base}': 'Merge into {base}',
  '收起 diff': 'Hide diff',
  diff: 'diff',
  '打开目录': 'Reveal in Finder',
  '主工作区': 'main',
  '{n} 处改动': '{n} changed',
  '端口 {port}': 'port {port}',
  '相对 {base} 无差异': 'No diff against {base}',
  '派给这个 worktree 的任务 prompt': 'Task prompt to dispatch into this worktree',
  '命令模板，{prompt} 占位符': 'Command template, use {prompt} placeholder',
  '派发 agent': 'Dispatch agent',
  '已派发到 {branch}，输出见下方运行流':
    'Dispatched to {branch}; see the run stream below',
  '该仓库还没有 worktree。': 'No worktrees in this repository yet.',
  '自定义命令': 'Custom command',
  '内置内核': 'built-in kernel',
  '并行舰队': 'Parallel fleet',
  '一个任务 → N 个 worktree → N 个 agent 同跑':
    'One task → N worktrees → N agents in parallel',
  '分支前缀，如 task': 'Branch prefix, e.g. task',
  '数量': 'count',
  '并行任务 prompt（每个 worktree 一份完整任务）':
    'Task prompt (each worktree gets the full task)',
  '派发中…': 'Dispatching…',
  '出发': 'Launch',
  '舰队已出发：{n} 个 agent 并行运行': 'Fleet launched: {n} agents running in parallel',
  '合并': 'Merge',
  '派发': 'Dispatch',
  '任务 prompt': 'Task prompt',
  '并行任务 prompt': 'Parallel task prompt',
  '当前会话没有绑定仓库目录。先在顶栏选项目并设置仓库路径。':
    'This session has no repository bound. Pick a project and set its repo path in the top bar.',
  '当前会话': 'current session',
  '在此对话': 'Chat here',
  '把当前会话切到这个 worktree（内核工作目录随之改变）':
    'Move the current session into this worktree (kernel working directory changes)',
  '会话已切入 worktree：{branch}': 'Session moved into worktree: {branch}',
  '会话已切入 worktree：{branch}（新会话，工作目录 {path}）':
    'Session moved into worktree: {branch} (new session, working directory {path})',
  行: 'lines',
  '{n} 分钟前': '{n}m ago',
  '{n} 小时前': '{n}h ago',
  '{n} 天前': '{n}d ago',
}
