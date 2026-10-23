/**
 * HTML 白名单消毒器（AUDIT-012②）。
 *
 * artifact 预览内容来自内核/磁盘（markdown 渲染结果、office 还原 HTML），
 * 直接 `v-html` 等于把不可信内容当 HTML 执行——一个 `<script>` 或 `onerror=`
 * 就是 XSS。本模块在渲染前做三重过滤：
 *   ① 标签白名单（不在表内的脱去外壳保留文本，危险标签连同内容整体移除）；
 *   ② 属性白名单（`on*`/`style`/`id`/`srcdoc` 等一律剥除）；
 *   ③ URL scheme 白名单（`javascript:` / `data:text/html` 等一律剥除）。
 * 不引第三方依赖；Tauri webview 与 vitest jsdom 均有 DOMParser。
 */

/** 允许保留的标签（文本结构 / 标题列表 / 表格 / 链接图片）。 */
const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'p', 'div', 'span', 'section', 'br', 'hr', 'pre', 'blockquote', 'code', 'em', 'strong',
  'b', 'i', 'u', 's', 'strike', 'sub', 'sup', 'small', 'mark', 'abbr', 'cite',
  'q', 'kbd', 'samp', 'var', 'wbr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'a', 'img',
])

/** 连同内容整体移除的标签：内容本身即可执行或可注入。 */
const DROP_WITH_CONTENT: ReadonlySet<string> = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template',
  'link', 'meta', 'base', 'form', 'input', 'button', 'select', 'textarea',
  'svg', 'math',
])

/** 按标签放行的属性；`*` 为所有标签共用。 */
const ALLOWED_ATTRS: Record<string, ReadonlySet<string>> = {
  a: new Set(['href', 'title']),
  img: new Set(['src', 'alt', 'title', 'width', 'height']),
  th: new Set(['colspan', 'rowspan']),
  td: new Set(['colspan', 'rowspan']),
  col: new Set(['span', 'width']),
  '*': new Set(['class', 'style']),
}

/**
 * style 属性内放行的 CSS 属性白名单。
 *
 * office 预览（docx-preview / sheet_to_html）靠内联样式做排版（列宽、对齐、
 * 字号），全剥 style 会让表格版式全废；但 style 又是 `url(javascript:)`
 * 类注入的入口，因此只放行纯排版属性，且值内出现 url(/expression/@ 即整条丢弃。
 */
const SAFE_CSS_PROPS: ReadonlySet<string> = new Set([
  'font-size', 'font-family', 'font-weight', 'font-style', 'line-height',
  'text-align', 'text-decoration', 'text-indent', 'vertical-align',
  'color', 'background-color',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-color', 'border-width', 'border-style', 'border-collapse',
  'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
  'white-space', 'word-break', 'overflow-wrap', 'list-style-type',
])

/** URL scheme 白名单（协议相对 URL `//host` 也禁——跨站面）。 */
const ALLOWED_URL_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:'])

/** 兜底转义：DOMParser 不可用时整段按纯文本转义——宁可丢格式不丢安全。 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * URL 安全性：相对路径与锚点放行；scheme 必须在白名单；
 * `data:` 仅放行位图（office/预览嵌图场景），`data:image/svg+xml` 禁
 * （SVG 可携带脚本，img 上下文虽不执行，但不给机会）。
 */
function isSafeUrl(raw: string): boolean {
  // 去掉控制字符与空白：`java\tscript:` 这类混淆变体在 trim 后仍带 :，须先剥掉。
  const v = raw.replace(/[\u0000-\u0020\s]+/g, '')
  if (!v) return true
  if (v.startsWith('#')) return true
  // 协议相对 URL（//host）必须先于普通相对路径判断：它同样以 / 开头，
  // 但是跨站引用面，禁。
  if (v.startsWith('//')) return false
  if (v.startsWith('/') || v.startsWith('./') || v.startsWith('../')) return true
  const lower = v.toLowerCase()
  if (/^data:image\/(png|jpeg|jpg|gif|webp|bmp)[;,]/.test(lower)) return true
  const m = /^([a-z][a-z0-9+.-]*):/.exec(lower)
  if (!m) return true
  return ALLOWED_URL_SCHEMES.has(`${m[1]}:`)
}

/** 剥除整棵子树的注释节点（条件注释等历史注入面）。 */
function stripComments(node: Node): void {
  for (const c of Array.from(node.childNodes)) {
    if (c.nodeType === Node.COMMENT_NODE) {
      c.remove()
    } else if (c.nodeType === Node.ELEMENT_NODE) {
      stripComments(c)
    }
  }
}

/**
 * style 属性值过滤：只保留白名单属性的声明；值里出现
 * `url(` / `expression` / `javascript:` / `@` / `<` / `\` 即整条丢弃。
 */
function sanitizeStyleValue(raw: string): string {
  const keep: string[] = []
  for (const decl of raw.split(';')) {
    const at = decl.indexOf(':')
    if (at < 0) continue
    const prop = decl.slice(0, at).trim().toLowerCase()
    const value = decl.slice(at + 1).trim()
    if (!prop || !value) continue
    if (!SAFE_CSS_PROPS.has(prop)) continue
    if (/url\(|expression|javascript:|@|<|\\/i.test(value)) continue
    keep.push(`${prop}: ${value}`)
  }
  return keep.join('; ')
}

/** 递归净化子元素。不认识标签的「先净化后代再脱壳保留文本」，文本不丢。 */
function sanitizeChildren(parent: Element): void {
  let child = parent.firstElementChild
  while (child) {
    // 脱壳会把后继节点插到 child 前面，先缓存 next 防遍历错乱。
    const next = child.nextElementSibling
    const tag = child.tagName.toLowerCase()
    if (DROP_WITH_CONTENT.has(tag)) {
      child.remove()
    } else if (!ALLOWED_TAGS.has(tag)) {
      sanitizeChildren(child)
      const parentNode = child.parentNode
      if (parentNode) {
        while (child.firstChild) parentNode.insertBefore(child.firstChild, child)
      }
      child.remove()
    } else {
      sanitizeAttrs(child)
      sanitizeChildren(child)
    }
    child = next
  }
}

/** 属性白名单过滤；URL 类属性再过 scheme 白名单；style 过 CSS 属性白名单。 */
function sanitizeAttrs(el: Element): void {
  const tag = el.tagName.toLowerCase()
  const allowed = new Set([...(ALLOWED_ATTRS[tag] ?? []), ...ALLOWED_ATTRS['*']])
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase()
    if (!allowed.has(name)) {
      el.removeAttribute(attr.name)
      continue
    }
    if (name === 'href' || name === 'src') {
      if (!isSafeUrl(attr.value)) el.removeAttribute(attr.name)
    } else if (name === 'style') {
      const safe = sanitizeStyleValue(attr.value)
      if (safe) el.setAttribute('style', safe)
      else el.removeAttribute('style')
    }
  }
}

/**
 * 消毒入口：输入任意 HTML 字符串，返回只含白名单标签/属性/URL 的安全 HTML。
 * 纯函数，可单测（tests/sanitizeHtml.spec.ts 覆盖 `<script>`/`onerror=`/`javascript:`）。
 */
export function sanitizeHtml(dirty: string): string {
  if (!dirty) return ''
  if (typeof DOMParser === 'undefined' || typeof document === 'undefined') {
    return escapeHtml(dirty)
  }
  const doc = new DOMParser().parseFromString(
    `<div id="__sanitize_root__">${dirty}</div>`,
    'text/html',
  )
  const root = doc.getElementById('__sanitize_root__')
  if (!root) return escapeHtml(dirty)
  stripComments(root)
  sanitizeChildren(root)
  return root.innerHTML
}
