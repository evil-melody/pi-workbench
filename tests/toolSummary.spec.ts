import { describe, expect, it } from 'vitest'
import {
  classifyTool,
  clipLines,
  deriveSummary,
  firstLine,
  formatToolBody,
  relativizeToCwd,
  summarizeToolCall,
  splitExitCode,
  toolArgsBlocks,
  toolRowState,
  SUMMARY_KEYS,
} from '@/utils/toolSummary'

/**
 * 工具行摘要的对拍用例：逐条锁住 WorkDSH `@deepseek-ai/dsh-client-ui-tool`
 * （/tmp/dsh-ui/.../package/lib/client.js 的 SUMMARY_KEYS / relativizeToCwd /
 * deriveSummary / toolRowModel）的行为，避免将来「顺手改文案」把与 dsh 的
 * 1:1 对齐改坏了。
 */

const ROOT = '/Users/me/repo'

describe('classifyTool', () => {
  it('已知工具按 dsh 原表归类，未知工具落 others', () => {
    expect(classifyTool('bash')).toBe('bash')
    expect(classifyTool('pwsh')).toBe('bash')
    expect(classifyTool('web_fetch')).toBe('read')
    expect(classifyTool('web_search')).toBe('search')
    expect(classifyTool('grep')).toBe('search')
    expect(classifyTool('run_code')).toBe('code')
    expect(classifyTool('mcp__x__y')).toBe('others')
  })
})

describe('relativizeToCwd', () => {
  it('工作区内绝对路径削成相对路径', () => {
    expect(relativizeToCwd(`${ROOT}/src/a.ts`, ROOT)).toBe('src/a.ts')
  })

  it('root 末尾多余的斜杠不影响匹配', () => {
    expect(relativizeToCwd(`${ROOT}/src/a.ts`, `${ROOT}/`)).toBe('src/a.ts')
    expect(relativizeToCwd(`${ROOT}/src/a.ts`, `${ROOT}//`)).toBe('src/a.ts')
  })

  it('反斜杠分隔同样处理（Windows）', () => {
    expect(relativizeToCwd(`${ROOT}\\src\\a.ts`, ROOT)).toBe('src\\a.ts')
  })

  it('root 外的路径原样保留（不能假装它是相对的）', () => {
    expect(relativizeToCwd('/etc/hosts', ROOT)).toBe('/etc/hosts')
    // 同名前缀但不是子目录：/Users/me/repo2 不该被削成 2/src
    expect(relativizeToCwd(`${ROOT}2/src/a.ts`, ROOT)).toBe(`${ROOT}2/src/a.ts`)
  })

  it('无 root（undefined / null / 空串）时整串原样', () => {
    expect(relativizeToCwd(`${ROOT}/a`, undefined)).toBe(`${ROOT}/a`)
    expect(relativizeToCwd(`${ROOT}/a`, null)).toBe(`${ROOT}/a`)
    expect(relativizeToCwd(`${ROOT}/a`, '')).toBe(`${ROOT}/a`)
  })
})

describe('deriveSummary 字段优先级', () => {
  it('SUMMARY_KEYS 与 dsh 原表一致', () => {
    expect(SUMMARY_KEYS).toEqual({
      bash: ['description', 'command'],
      read: ['path', 'file_path', 'url'],
      search: ['query', 'pattern', 'url'],
      write: ['path', 'file_path'],
      edit: ['path', 'file_path'],
      code: ['description'],
      others: [],
    })
  })

  it('bash：description 优先于 command（dsh 把描述放在第一顺位）', () => {
    expect(deriveSummary('bash', '{"command":"ls -la","description":"列目录"}')).toBe('列目录')
    expect(deriveSummary('bash', '{"command":"ls -la"}')).toBe('ls -la')
  })

  it('read：path → file_path → url 依次取', () => {
    expect(deriveSummary('read', '{"file_path":"a.ts","path":"b.ts"}')).toBe('b.ts')
    expect(deriveSummary('read', '{"file_path":"a.ts"}')).toBe('a.ts')
    expect(deriveSummary('read', '{"url":"https://x.dev"}')).toBe('https://x.dev')
  })

  it('search：query → pattern → url；write / edit / code 取各自字段', () => {
    expect(deriveSummary('search', '{"pattern":"foo","query":"bar"}')).toBe('bar')
    expect(deriveSummary('search', '{"pattern":"foo"}')).toBe('foo')
    expect(deriveSummary('search', '{"url":"https://s.dev?q=1"}')).toBe('https://s.dev?q=1')
    expect(deriveSummary('write', '{"path":"src/a.ts","content":"x"}')).toBe('src/a.ts')
    expect(deriveSummary('edit', '{"file_path":"src/a.ts","old_string":"a"}')).toBe('src/a.ts')
    expect(deriveSummary('code', '{"description":"算一下","code":"1+1"}')).toBe('算一下')
  })

  it('指定字段都不在时，退回第一个非空字符串字段（按声明顺序）', () => {
    expect(deriveSummary('read', '{"note":"兜底文本","n":1}')).toBe('兜底文本')
    expect(deriveSummary('others', '{"anything":"值"}')).toBe('值')
  })

  it('没有任何字符串字段 / 参数不是 JSON 对象 → 原始参数首行', () => {
    expect(deriveSummary('read', '{"n":1,"b":true}')).toBe('{"n":1,"b":true}')
    expect(deriveSummary('read', 'not json')).toBe('not json')
    expect(deriveSummary('read', 'null')).toBe('null')
    expect(deriveSummary('read', '')).toBe('')
  })

  it('多行值只取首行（摘要行必须是单行）', () => {
    expect(deriveSummary('bash', '{"command":"echo a\\nb"}')).toBe('echo a')
    expect(deriveSummary('bash', '第一行\n第二行')).toBe('第一行')
  })

  it('空字符串字段跳过，继续找下一个', () => {
    expect(deriveSummary('bash', '{"description":"","command":"ls"}')).toBe('ls')
  })
})

describe('summarizeToolCall', () => {
  it('已知工具：标题用变体名，摘要取指定字段并相对化，图标按变体就近映射', () => {
    expect(summarizeToolCall('read', `{"path":"${ROOT}/src/a.ts"}`, ROOT)).toEqual({
      title: 'Read',
      summary: 'src/a.ts',
      icon: 'file',
    })
    expect(summarizeToolCall('bash', '{"command":"ls -la /tmp"}', ROOT)).toEqual({
      title: 'Bash',
      summary: 'ls -la /tmp',
      icon: 'terminal',
    })
    expect(summarizeToolCall('grep', '{"pattern":"foo"}', ROOT)).toEqual({
      title: 'Search',
      summary: 'foo',
      icon: 'search',
    })
  })

  it('工具自有标题优先于变体标题（pwsh 显示 Pwsh，仍走 bash 摘要规则）', () => {
    const r = summarizeToolCall('pwsh', '{"command":"dir","description":"列文件"}', ROOT)
    expect(r.title).toBe('Pwsh')
    expect(r.summary).toBe('列文件')
    expect(r.icon).toBe('terminal')
  })

  it('cordis_unmount 变体是 others 但有自有标题：不前置工具名（dsh 原条件）', () => {
    expect(summarizeToolCall('cordis_unmount', '{"id":"x"}', ROOT)).toEqual({
      title: 'Unmount temporary Plugin',
      summary: 'x',
      icon: 'tool',
    })
  })

  it('未知工具：标题 Tool call，摘要前置原始工具名', () => {
    expect(summarizeToolCall('mcp__db__query', '{"sql":"select 1"}', ROOT)).toEqual({
      title: 'Tool call',
      summary: 'mcp__db__query · select 1',
      icon: 'tool',
    })
  })

  it('名字未回填（空工具名）只给中性标题，不编造摘要', () => {
    expect(summarizeToolCall('', '{"command":"ls"}', ROOT)).toEqual({
      title: 'Tool call',
      summary: '',
      icon: 'tool',
    })
  })

  it('无参数时不出现「name · 」空尾巴', () => {
    expect(summarizeToolCall('mcp__x', '', ROOT).summary).toBe('mcp__x')
    expect(summarizeToolCall('read', '', ROOT).summary).toBe('')
  })

  it('超长摘要截到 240 字符加省略号（防止整段 JSON 进 DOM）', () => {
    const long = 'x'.repeat(300)
    const r = summarizeToolCall('bash', JSON.stringify({ command: long }), ROOT)
    expect(r.summary).toHaveLength(241)
    expect(r.summary.endsWith('…')).toBe(true)
  })
})

describe('formatToolBody', () => {
  it('可解析的参数缩进两格打印（dsh deriveBody）', () => {
    expect(formatToolBody('{"a":1,"b":[2]}')).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}')
  })

  it('不可解析 / 空串原样返回', () => {
    expect(formatToolBody('plain text')).toBe('plain text')
    expect(formatToolBody('')).toBe('')
  })
})

describe('toolRowState', () => {
  it('失败优先于结果（dsh 的 failure 判定在 done 之前）', () => {
    expect(toolRowState({ toolResult: 'partial', toolError: 'boom' })).toBe('error')
    expect(toolRowState({ toolError: true, streaming: true })).toBe('error')
  })

  it('有结果即 ok；没结果但本轮在跑才是 running', () => {
    expect(toolRowState({ toolResult: 'total 8' })).toBe('ok')
    expect(toolRowState({ streaming: true })).toBe('running')
  })

  it('落定后仍无结果按 ok 兜底（内核不回结果不等于失败）', () => {
    expect(toolRowState({})).toBe('ok')
  })
})

describe('firstLine / clipLines', () => {
  it('firstLine 只取首行（失败行的摘要位置放错误第一行）', () => {
    expect(firstLine('boom\nat foo')).toBe('boom')
    expect(firstLine('single')).toBe('single')
    expect(firstLine('')).toBe('')
  })

  it('clipLines 默认截 8 行并报出隐藏行数（dsh maxLines: 8）', () => {
    const text = Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n')
    expect(clipLines(text)).toEqual({ text: 'l0\nl1\nl2\nl3\nl4\nl5\nl6\nl7', hidden: 2 })
  })

  it('未超上限与空串不截', () => {
    expect(clipLines('a\nb')).toEqual({ text: 'a\nb', hidden: 0 })
    expect(clipLines('')).toEqual({ text: '', hidden: 0 })
  })

  it('max=Infinity 全量返回（对应「展开剩余 N 行」后的状态）', () => {
    const text = Array.from({ length: 10 }, (_, i) => `l${i}`).join('\n')
    expect(clipLines(text, Infinity)).toEqual({ text, hidden: 0 })
  })
})

describe('toolArgsBlocks · 展开体参数结构化', () => {
  it('bash 的命令渲染成命令原文，不再带 JSON 花括号', () => {
    const blocks = toolArgsBlocks('bash', '{"command":"pnpm test 2>&1 | head -100","description":"跑测试"}')
    expect(blocks).toEqual([{ label: '命令', text: 'pnpm test 2>&1 | head -100', code: true }])
    expect(blocks[0].text).not.toContain('{')
  })

  it('read 只有路径一行；工作区内的绝对路径削成相对路径', () => {
    expect(toolArgsBlocks('read', '{"path":"/repo/src/a.ts"}', '/repo')).toEqual([
      { label: '路径', text: 'src/a.ts', code: false },
    ])
  })

  it('write 是路径 + 内容块，edit 是路径 + 替换前 / 替换后', () => {
    const write = toolArgsBlocks('write', '{"file_path":"a.ts","content":"line1\\nline2"}')
    expect(write.map((b) => b.label)).toEqual(['路径', '内容'])
    expect(write[1].text).toBe('line1\nline2')

    const edit = toolArgsBlocks('edit', '{"path":"a.ts","oldString":"x","newString":"y"}')
    expect(edit.map((b) => b.label)).toEqual(['路径', '替换前', '替换后'])
  })

  it('取不到已知字段回落缩进 JSON（不编造语义）', () => {
    expect(toolArgsBlocks('grep', '{"pattern":"foo","glob":"*.ts"}')).toEqual([
      { label: '参数', text: '{\n  "pattern": "foo",\n  "glob": "*.ts"\n}', code: true },
    ])
  })

  it('参数解析不了时原样兜住，空参数不出块', () => {
    expect(toolArgsBlocks('bash', 'not json at all')).toEqual([{ label: '参数', text: 'not json at all', code: true }])
    expect(toolArgsBlocks('bash', '')).toEqual([])
  })
})

describe('splitExitCode · 退出码摘出', () => {
  it('行尾的 exited with code N 单独成行', () => {
    expect(splitExitCode('Compiling...\nerror: aborting\ndue to previous error\nexited with code 1')).toEqual({
      body: 'Compiling...\nerror: aborting\ndue to previous error',
      exit: 'exited with code 1',
    })
  })

  it('Exit code: 0 与整串只有退出码也识别', () => {
    expect(splitExitCode('ok\nExit code: 0')).toEqual({ body: 'ok', exit: 'Exit code: 0' })
    expect(splitExitCode('exited with code 2')).toEqual({ body: '', exit: 'exited with code 2' })
  })

  it('内核 0.87.x 实证写法：空行后的 Command exited with code N', () => {
    // chunk-OJP47DM6.js：非零退出时 `text += \n\nCommand exited with code ${exitCode}`
    expect(splitExitCode('FAIL tests/x.spec.ts\n\nCommand exited with code 1')).toEqual({
      body: 'FAIL tests/x.spec.ts',
      exit: 'Command exited with code 1',
    })
  })

  it('正文中间出现的 code 不误摘；空串安全', () => {
    expect(splitExitCode('exit code 1 was mentioned in the log')).toEqual({
      body: 'exit code 1 was mentioned in the log',
      exit: '',
    })
    expect(splitExitCode('')).toEqual({ body: '', exit: '' })
  })
})
