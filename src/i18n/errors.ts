import { currentLocale, t } from './index'

/**
 * 后端错误码 → 中文源文。key 仍是中文原文，错误码只做查表用，
 * 查不到就退回后端 `detail`，绝不把 `err.xxx` 这类 raw key 显示给用户。
 */
const ERROR_TEXT: Record<string, string> = {
  'common/unknown': '未知错误',
  'common/io': '读写失败：{detail}',
  'common/not-found': '未找到：{detail}',
  'settings/invalid': '设置无效：{detail}',
  'settings/save-failed': '保存设置失败：{detail}',
  'projects/not-found': '项目不存在：{detail}',
  'projects/path-invalid': '项目路径无效：{detail}',
  'projects/name-empty': '项目名称不能为空',
  'projects/empty-name': '项目名称不能为空',
  'projects/invalid-name': '项目名称无效',
  'projects/invalid-title': '项目标题无效',
  'projects/no-path': '项目还没有绑定目录',
  'projects/template-not-found': '项目模板不存在',
  'projects/revision-conflict': '内容已在别处修改，请刷新后重试',
  'projects/reference-stale': '引用的资料或能力已失效，请刷新后重试',
  'projects/capability-not-bound': '该项目未绑定该能力',
  'projects/instruction-budget-exceeded': '项目指令超出长度上限',
  'library/not-found': '资料不存在：{detail}',
  'library/disabled': '资料已停用：{detail}',
  'library/path-invalid': '路径无效：{detail}',
  'library/path-too-long': '路径过长',
  'library/path-taken': '该路径已被占用：{detail}',
  'library/source-missing': '源文件已不存在',
  'library/revision-missing': '该修订不存在',
  'library/already-registered': '该文件已在资料库中',
  'library/name-required': '名称不能为空',
  'library/name-invalid': '名称含非法字符',
  'library/too-large': '文件过大',
  'library/quotas-exceeded': '资料库配额已满',
  'library/file-too-large': '文件过大（上限 {limit} MB）',
  'library/path-outside': '路径不在资料库范围内：{detail}',
  'memory/empty': '内容不能为空',
  'experts/not-found': '专家不存在：{detail}',
  'experts/confirmation-required': '需要先确认再执行',
  'experts/confirmation-stale': '确认已过期，请重新发起',
  'connector/not-found': '连接器不存在：{detail}',
  'connector/server-name-invalid': '服务名只能包含字母、数字、- 和 _',
  'connector/url-required': 'URL 不能为空',
  'connector/url-invalid': 'URL 无效：{detail}',
  'connector/command-required': '命令不能为空',
  'definition/required': '必填项缺失：{detail}',
  'definition/limit': '定义数量超出上限',
  'definition/template-braces': '模板花括号不匹配',
  'definition/duplicate-tag': '标签重复：{detail}',
  'definition/duplicate-example-id': '示例 ID 重复：{detail}',
  'capabilities/unavailable': '能力清单不可用：{detail}',
  'pi/not-running': 'Pi 内核未运行',
  'pi/start-failed': '拉起内核失败：{detail}',
}

/**
 * 后端 `detail` 的兜底清洗：去掉 `Error:` / `TypeError:` 类前缀、只留第一行、
 * 限长。词条里的 `{detail}` 也可能塞进堆栈，界面上一律不出现技术文本。
 */
export function cleanErrorDetail(detail: string): string {
  const line = detail.split('\n').find((l) => l.trim()) ?? ''
  const text = line.replace(/^[\w$.]*(?:Error|Exception)\s*[:：]\s*/i, '').trim()
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}

export function ipcErrorText(
  code: string,
  params?: Record<string, unknown>,
  detail?: string,
): string {
  const source = ERROR_TEXT[code]
  if (source) return t(source, params)
  // 后端 detail 是中文：英文界面透出会中英混排，退回通用英文词条。
  if (detail && currentLocale() === 'zh-CN') return cleanErrorDetail(detail)
  return t('未知错误')
}
