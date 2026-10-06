import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { shouldShowHero } from '@/composables/chatStage'
import { chatEpoch, startNewSession } from '@/composables/useChatSession'

/**
 * 对话页「两段式」版式守卫。
 *
 * 背景（用户截图反馈的原话）：
 *   选了项目进来后……选择了项目，应该还停留在原来的界面吧。
 * 老实现把 `cwd` 也塞进 Hero 判据：
 *   `!cwd && messages.length === 0 && !streaming`
 * 于是「一选完项目，落地页当场消失」—— 用户被扔进一个还没有任何消息的会话流里，
 * 左边文件树、右边浏览器/终端一起压上来，中间只剩一条被挤窄的空对话。
 * 这个缺陷 typecheck / build 全绿，只有真的看一眼界面才发现。
 */

const CHAT_VIEW = fileURLToPath(new URL('../src/views/ChatView.vue', import.meta.url))
const src = readFileSync(CHAT_VIEW, 'utf8')

describe('shouldShowHero', () => {
  it('没有消息时停在落地页', () => {
    expect(shouldShowHero(0, false)).toBe(true)
  })

  it('发出第一条消息后进入会话流', () => {
    expect(shouldShowHero(1, false)).toBe(false)
    expect(shouldShowHero(12, false)).toBe(false)
  })

  it('内核正在流式输出时不停在落地页', () => {
    expect(shouldShowHero(0, true)).toBe(false)
  })

  it('判据只有两个输入：目录不进判据（选完项目仍停在原地）', () => {
    expect(shouldShowHero.length).toBe(2)
  })
})

describe('对话页版式守卫（源码级）', () => {
  it('Hero 判据不得依赖工作目录', () => {
    const m = src.match(/const showHero = computed\(\(\) =>([\s\S]*?)\)\n/)
    expect(m, '没找到 showHero 判据，版式守卫失效').toBeTruthy()
    expect(m![1]).not.toMatch(/cwd/)
  })

  it('对话页不再常驻文件树 / 终端 / 浏览器三栏', () => {
    expect(src).not.toMatch(/<FileTree/)
    expect(src).not.toMatch(/<TerminalPanel/)
    expect(src).not.toMatch(/<AgentBrowserPane/)
    expect(src).not.toMatch(/class="left"/)
    expect(src).not.toMatch(/class="right"/)
  })

  it('轨迹这类过程面板收进抽屉，按需打开', () => {
    expect(src).toMatch(/<TraceDrawer/)
  })

  it('文件编辑面板已抽出为可复用组件（对话页与项目工作台共用一份）', () => {
    expect(src).not.toMatch(/\.fbar/)
    const pane = readFileSync(
      fileURLToPath(new URL('../src/components/fs/FileEditorPane.vue', import.meta.url)),
      'utf8',
    )
    expect(pane).toMatch(/<style src="\.\/FileEditorPane\.css" scoped>/)
  })
})

describe('新会话', () => {
  it('轮次加一，用来强制对话页重挂载', () => {
    const before = chatEpoch.value
    startNewSession()
    expect(chatEpoch.value).toBe(before + 1)
  })

  it('路由视图按轮次给对话页做 key（否则 push 同路由等于没点）', () => {
    const app = readFileSync(fileURLToPath(new URL('../src/App.vue', import.meta.url)), 'utf8')
    expect(app).toMatch(/chat-\$\{chatEpoch\}|`chat-\$\{chatEpoch\}`/)
  })
})
