// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { sanitizeHtml } from '@/utils/sanitizeHtml'

describe('sanitizeHtml · 可执行内容清除', () => {
  it('<script> 连同内容整体移除', () => {
    const out = sanitizeHtml('<p>前</p><script>alert(1)</script><p>后</p>')
    expect(out).not.toContain('script')
    expect(out).not.toContain('alert')
    expect(out).toContain('前')
    expect(out).toContain('后')
  })

  it('<style> 连同内容整体移除', () => {
    const out = sanitizeHtml('<style>body{display:none}</style><p>正文</p>')
    expect(out).not.toContain('style')
    expect(out).not.toContain('display')
    expect(out).toContain('正文')
  })

  it('onerror= / onclick= 等事件属性一律剥除', () => {
    const out = sanitizeHtml('<img src="https://e.com/a.png" onerror="alert(1)" onclick="x()">')
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('onclick')
    expect(out).toContain('src="https://e.com/a.png"')
  })

  it('javascript: 伪协议的 href/src 被剥除', () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">点我</a><img src="javascript:alert(2)">')
    expect(out).not.toContain('javascript:')
    expect(out).toContain('点我')
  })

  it('混淆变体（控制字符/大小写/实体）也拦得住', () => {
    const out = sanitizeHtml('<a href="java\tscript:alert(1)">a</a><a href="JaVaScRiPt:alert(1)">b</a>')
    expect(out).not.toContain('javascript:')
    expect(out).not.toContain('alert')
  })

  it('data:text/html 被拦，data:image/png 放行', () => {
    const bad = sanitizeHtml('<img src="data:text/html;base64,PHNjcmlwdD4=">')
    expect(bad).not.toContain('data:text/html')
    const ok = sanitizeHtml('<img src="data:image/png;base64,iVBORw0KGgo=">')
    expect(ok).toContain('data:image/png')
  })

  it('协议相对 URL //host 被拦', () => {
    const out = sanitizeHtml('<img src="//evil.example.com/a.png">')
    expect(out).not.toContain('//evil.example.com')
  })

  it('id 属性被剥除，class 与安全 CSS 属性保留', () => {
    const out = sanitizeHtml('<p id="x" style="color:red" class="md">t</p>')
    expect(out).not.toContain('id=')
    expect(out).toContain('class="md"')
    expect(out).toContain('color: red')
  })

  it('style 白名单：排版属性保留，危险属性/值整条丢弃', () => {
    const ok = sanitizeHtml(
      '<table><tr><td colspan="2" style="width:80px;text-align:center">x</td></tr></table>',
    )
    expect(ok).toContain('width: 80px')
    expect(ok).toContain('text-align: center')
    const bad = sanitizeHtml(
      '<div style="position:fixed;inset:0;background:url(javascript:alert(1))">x</div>',
    )
    expect(bad).not.toContain('position')
    expect(bad).not.toContain('url(')
    expect(bad).not.toContain('inset')
  })

  it('注释节点被剥除', () => {
    const out = sanitizeHtml('<p>a</p><!-- <script>alert(1)</script> -->')
    expect(out).not.toContain('<!--')
    expect(out).not.toContain('script')
  })

  it('iframe/object/embed 等连同内容移除', () => {
    const out = sanitizeHtml('<iframe src="https://evil.example.com"></iframe><p>ok</p>')
    expect(out).not.toContain('iframe')
    expect(out).not.toContain('evil.example.com')
    expect(out).toContain('ok')
  })
})

describe('sanitizeHtml · 白名单内容保留', () => {
  it('标题/列表/表格/链接/图片结构原样保留', () => {
    const html =
      '<h1>标题</h1><ul><li>项</li></ul>' +
      '<table><tr><th colspan="2">头</th></tr><tr><td>值</td></tr></table>' +
      '<a href="https://example.com/a?b=1" title="t">链接</a>' +
      '<img src="https://example.com/i.png" alt="图" width="10">'
    const out = sanitizeHtml(html)
    expect(out).toContain('<h1>标题</h1>')
    expect(out).toContain('<li>项</li>')
    expect(out).toContain('colspan="2"')
    expect(out).toContain('href="https://example.com/a?b=1"')
    expect(out).toContain('alt="图"')
    expect(out).toContain('width="10"')
  })

  it('不认识的标签脱壳保留文本（不丢用户可见内容）', () => {
    const out = sanitizeHtml('<font color="red">红字</font><custom-tag>自定义</custom-tag>')
    expect(out).not.toContain('font')
    expect(out).not.toContain('custom-tag')
    expect(out).toContain('红字')
    expect(out).toContain('自定义')
  })

  it('嵌套结构递归净化：白名单标签内的 script 也清得掉', () => {
    const out = sanitizeHtml('<div><p>ok<script>alert(1)</script></p></div>')
    expect(out).not.toContain('script')
    expect(out).toContain('ok')
  })

  it('相对路径与锚点 URL 放行', () => {
    const out = sanitizeHtml('<a href="#top">顶</a><a href="/docs/a.md">文档</a>')
    expect(out).toContain('href="#top"')
    expect(out).toContain('href="/docs/a.md"')
  })

  it('office 预览常用结构保留：section/colgroup/col width/sheet 类名', () => {
    const out = sanitizeHtml(
      '<section class="sheet"><h4 class="sname">表1</h4>' +
        '<table><colgroup><col style="width:72px" span="1"></colgroup>' +
        '<tr><td style="width:72px">A</td></tr></table></section>',
    )
    expect(out).toContain('<section class="sheet">')
    expect(out).toContain('class="sname"')
    expect(out).toContain('width: 72px')
    expect(out).toContain('span="1"')
  })

  it('空输入返回空串', () => {
    expect(sanitizeHtml('')).toBe('')
  })
})
