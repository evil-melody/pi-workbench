import { invoke } from '@tauri-apps/api/core'
import { ref, watch, type Ref } from 'vue'
import { IN_TAURI, type PiMsg } from './usePi'

export type ArtifactKind =
  | 'html'
  | 'markdown'
  | 'json'
  | 'svg'
  | 'image'
  | 'text'
  /** Office/PDF：后端给原始字节，前端解析器渲染，只读、不承诺保真。 */
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'pdf'

export interface Artifact {
  path: string
  name: string
  ext: string
  kind: ArtifactKind
  bytes: number
  lines: number
}

export interface ScanSource {
  id: string
  text: string
}

export interface ScanResult {
  messageId: string
  artifacts: Artifact[]
}

export interface ArtifactContent {
  path: string
  kind: ArtifactKind
  content: string
  truncated: boolean
  totalBytes: number
}

const SCAN_DEBOUNCE = 500

export function useArtifacts(root: Ref<string>) {
  const byMessage = ref<Record<string, Artifact[]>>({})

  async function scan(messages: PiMsg[]) {
    if (!IN_TAURI) return
    const sources: ScanSource[] = messages
      .filter((m) => m.text && m.text.trim())
      .map((m) => ({ id: m.id, text: m.text }))
    if (!sources.length) {
      byMessage.value = {}
      return
    }
    try {
      const res = await invoke<ScanResult[]>('artifacts_scan', {
        root: root.value,
        sources,
      })
      const map: Record<string, Artifact[]> = {}
      for (const r of res) map[r.messageId] = r.artifacts
      byMessage.value = map
    } catch {
      // 会话解析失败不影响对话本身，退化为不显示成果卡片。
      byMessage.value = {}
    }
  }

  /**
   * 流式输出期间不扫描：每个 text_delta 都会改变消息内容，
   * 边扫边调会把内核请求打爆；等这一轮落定后再补扫一次即可。
   */
  function auto(messages: Ref<PiMsg[]>, streaming: Ref<boolean>) {
    let timer: ReturnType<typeof setTimeout> | null = null
    const stop = watch(
      [messages, streaming, root],
      () => {
        if (streaming.value) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          void scan(messages.value)
        }, SCAN_DEBOUNCE)
      },
      { deep: true },
    )
    return () => {
      if (timer) clearTimeout(timer)
      stop()
    }
  }

  return { byMessage, scan, auto }
}

/**
 * 读取单个成果内容。与扫描不同，这一步不需要响应式 root，
 * 因此放在模块级导出，让预览组件不必自建一个 composable 实例。
 */
export function readArtifact(
  root: string,
  artifact: Artifact,
): Promise<ArtifactContent> {
  if (!IN_TAURI) {
    return Promise.reject(new Error('当前是浏览器模式，无法读取文件'))
  }
  return invoke<ArtifactContent>('artifacts_read', { root, path: artifact.path })
}

/** 只有这几类走字节流预览，其余走文本。与后端 `artifacts::is_stream_kind` 对应。 */
export function isOfficeKind(kind: ArtifactKind): boolean {
  return kind === 'docx' || kind === 'xlsx' || kind === 'pptx' || kind === 'pdf'
}

/** 调系统默认应用打开。浏览器模式下没有系统，直接给可读原因。 */
export async function openExternal(path: string): Promise<void> {
  if (!IN_TAURI) throw new Error('当前是浏览器模式，无法调用系统应用')
  await invoke('artifacts_open', { path })
}

/** 卡片上的体积展示：小于 1KB 用 B，避免「0 KB」这种看不出量的表述。 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}
