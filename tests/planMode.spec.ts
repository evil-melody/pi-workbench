import { describe, expect, it } from 'vitest'
import { splitPromptBody } from '@/composables/usePi'
import {
  PLAN_INSTRUCTION,
  buildExecPrompt,
  parsePlanSteps,
  withPlanInstruction,
} from '@/utils/planMode'

/**
 * G5 Plan 模式（对齐 Cursor Plan mode / Claude Code 计划批准流）：
 * 发送前注入计划指令前缀 → 内核先出分步计划不动工具 → 前端解析成计划卡
 * → 用户点「开始执行」才发执行 prompt。
 *
 * 这里锁三件事：前缀注入与回放剥离互逆、计划解析的格式兼容、
 * 执行 prompt 必须带原任务（否则内核执行时丢了目标）。
 */
describe('withPlanInstruction', () => {
  it('指令前缀拼在最外（preamble 之前），原文紧随其后', () => {
    const body = withPlanInstruction('帮我修索引')
    expect(body.startsWith(PLAN_INSTRUCTION)).toBe(true)
    expect(body).toBe(`${PLAN_INSTRUCTION}\n\n帮我修索引`)
  })

  it('回放互逆：无 preamble 时 splitPromptBody 剥掉计划指令露出原文', () => {
    const body = withPlanInstruction('帮我修索引')
    expect(splitPromptBody(body).text).toBe('帮我修索引')
  })

  it('回放互逆：有 preamble 时计划指令落在被剥掉的前缀侧', () => {
    const body = withPlanInstruction('[项目上下文]\nxxx\n\n---\n\n帮我修索引')
    expect(splitPromptBody(body).text).toBe('帮我修索引')
  })

  it('回放互逆：带附件时同样只还原原文', () => {
    const body = withPlanInstruction('分析这张图\n\n[附件 / attachments]\n- image: /x/a.png')
    const back = splitPromptBody(body)
    expect(back.text).toBe('分析这张图')
    expect(back.attachments).toHaveLength(1)
  })

  it('非 plan 轮不受影响：splitPromptBody 原样返回', () => {
    expect(splitPromptBody('普通一句话').text).toBe('普通一句话')
  })
})

describe('parsePlanSteps', () => {
  it('编号列表（英文句点）每步一行', () => {
    expect(parsePlanSteps('1. 定位索引锁\n2. 改成不可重入安全调用\n3. 补回归测试')).toEqual([
      '定位索引锁',
      '改成不可重入安全调用',
      '补回归测试',
    ])
  })

  it('兼容中文序号与右括号序号', () => {
    expect(parsePlanSteps('1、第一步\n2)第二步')).toEqual(['第一步', '第二步'])
  })

  it('兼容 bullet 三种符号', () => {
    expect(parsePlanSteps('- A\n* B\n• C')).toEqual(['A', 'B', 'C'])
  })

  it('前后散文行被丢弃，只留步骤行', () => {
    const text = '好的，先看代码再动手。计划如下：\n1. 读索引模块\n2. 修死锁\n\n有问题随时调整。'
    expect(parsePlanSteps(text)).toEqual(['读索引模块', '修死锁'])
  })

  it('缩进的编号行也算步骤', () => {
    expect(parsePlanSteps('  1. 缩进步')).toEqual(['缩进步'])
  })

  it('剥掉整行加粗标记', () => {
    expect(parsePlanSteps('1. **修改索引锁**')).toEqual(['修改索引锁'])
  })

  it('空步骤行被过滤', () => {
    expect(parsePlanSteps('1. \n2. -\n3. 真实步骤')).toEqual(['真实步骤'])
  })

  it('空文本 / 无列表文本返回空数组（按普通回复处理）', () => {
    expect(parsePlanSteps('')).toEqual([])
    expect(parsePlanSteps('我直接说结论：没什么可计划的。')).toEqual([])
  })

  it('步骤数封顶 20，防失控输出撑爆卡片', () => {
    const many = Array.from({ length: 35 }, (_, i) => `${i + 1}. 步骤${i + 1}`).join('\n')
    expect(parsePlanSteps(many)).toHaveLength(20)
  })
})

describe('buildExecPrompt', () => {
  it('带编号步骤与原始任务（执行时不能丢目标）', () => {
    const p = buildExecPrompt('修索引死锁', ['读代码', '改锁', '补测试'])
    expect(p).toContain('1. 读代码')
    expect(p).toContain('2. 改锁')
    expect(p).toContain('3. 补测试')
    expect(p).toContain('原始任务：修索引死锁')
  })

  it('空步骤也不抛（退化成只带任务）', () => {
    const p = buildExecPrompt('做点什么', [])
    expect(p).toContain('原始任务：做点什么')
  })
})
