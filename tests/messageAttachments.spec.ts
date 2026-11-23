// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MessageAttachments from '@/components/chat/MessageAttachments.vue'
import type { PiAttachment } from '@/composables/usePi'

function mountAttachments(attachments: PiAttachment[]) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const errors: unknown[] = []
  const app = createApp({ render: () => h(MessageAttachments, { attachments }) })
  app.config.errorHandler = (e) => errors.push(e)
  app.mount(host)
  return { host, errors, app }
}

const image: PiAttachment = { id: 'a1', name: 'shot.png', kind: 'image', path: '/x/shot.png', size: 2048 }
const file: PiAttachment = { id: 'a2', name: 'store.ts', kind: 'file', path: '/x/store.ts', size: 2048 }

describe('MessageAttachments', () => {
  it('图片给缩略图，点开出现大图预览', async () => {
    const { host, errors } = mountAttachments([image])
    await nextTick()

    expect(errors).toEqual([])
    const thumb = host.querySelector<HTMLButtonElement>('.ma-thumb')!
    expect(thumb).toBeTruthy()
    expect(thumb.querySelector('img')!.getAttribute('src')).toBe('/x/shot.png')
    // 气泡里不摊路径，只给图。
    expect(host.textContent).not.toContain('/x/shot.png')

    thumb.click()
    await nextTick()
    expect(document.querySelector('.ma-lightbox img')?.getAttribute('src')).toBe('/x/shot.png')
    expect(document.querySelector('.ma-lightbox-meta')?.textContent).toContain('PNG · 2.0 KB')
  })

  it('普通文件给卡片：文件名、类型、大小', async () => {
    const { host } = mountAttachments([file])
    await nextTick()

    expect(host.querySelector('.ma-thumb')).toBeNull()
    expect(host.querySelector('.ma-file-name')?.textContent).toBe('store.ts')
    expect(host.querySelector('.ma-file-meta')?.textContent).toBe('TS · 2.0 KB')
  })

  it('旧 journal 缺 size 时标明大小未知，不显示 0 B', async () => {
    const { host } = mountAttachments([{ ...file, size: undefined }])
    await nextTick()
    expect(host.querySelector('.ma-file-meta')?.textContent).toBe('TS · 大小未知')
  })

  it('图片加载失败退化成文件卡，不留破图', async () => {
    const { host } = mountAttachments([image])
    await nextTick()
    host.querySelector('.ma-thumb img')!.dispatchEvent(new Event('error'))
    await nextTick()

    expect(host.querySelector('.ma-thumb')).toBeNull()
    expect(host.querySelector('.ma-file-name')?.textContent).toBe('shot.png')
  })
})
