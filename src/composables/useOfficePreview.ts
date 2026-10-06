import type { ArtifactKind } from './useArtifacts'

/**
 * Office 只读预览。
 *
 * 选型依据（均为真实可查的开源实现，非自造）：
 *   - docx → `docx-preview`（VolodymyrBaydalka/docxjs，Apache-2.0），还原 Word 原始版式。
 *   - xlsx → `xlsx`（SheetJS 0.18.5，Apache-2.0）解析后进 `sheet_to_html`。
 *   - pptx / pdf → 本轮不提供在线预览， UI 只给「用外部应用打开」，不承诺保真。
 *
 * 两个依赖都不轻（docx-preview 约 1MB），一律走动态导入，避免拖慢首屏。
 */

function base64ToArrayBuffer(dataUrl: string): ArrayBuffer {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const bin = atob(b64)
  const buf = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i)
  return buf.buffer
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** 把字节流渲染成可直接 v-html 的 HTML。 */
export async function officeToHtml(kind: ArtifactKind, dataUrl: string): Promise<string> {
  const bytes = base64ToArrayBuffer(dataUrl)

  if (kind === 'docx') {
    const { renderAsync } = await import('docx-preview')
    const host = document.createElement('div')
    // 渲染是往容器里塞节点，取 innerHTML 交给外层模板，组件本身不必持有 DOM 引用。
    await renderAsync(bytes, host)
    return host.innerHTML
  }

  if (kind === 'xlsx') {
    const XLSX = await import('xlsx')
    const wb = XLSX.read(bytes, { type: 'array' })
    // SheetJS 0.18.5 的 d.ts 只导出了部分 utils，工作表接口未声明，这里显式收窄。
    const utils = XLSX.utils as unknown as {
      book_get_sheet_names(book: unknown): string[]
      book_get_sheet(book: unknown, name: string): unknown
      sheet_to_html(sheet: unknown): string
    }
    const sheets = utils.book_get_sheet_names(wb)
    if (!sheets.length) return '<p class="empty">工作簿里没有工作表</p>'
    return sheets
      .map((name) => {
        const ws = utils.book_get_sheet(wb, name)
        const table = ws ? utils.sheet_to_html(ws) : ''
        return `<section class="sheet"><h4 class="sname">${escapeHtml(name)}</h4>${table}</section>`
      })
      .join('')
  }

  throw new Error(`${kind.toUpperCase()} 暂不支持在线预览，请用「用外部应用打开」`)
}
