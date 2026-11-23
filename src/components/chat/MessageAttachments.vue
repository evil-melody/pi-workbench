<script setup lang="ts">
import { ref } from 'vue'
import { convertFileSrc } from '@tauri-apps/api/core'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import { IN_TAURI } from '@/composables/usePi'
import { t } from '@/i18n'
import { attachmentIcon, attachmentMeta } from '@/utils/attachmentMeta'

interface AttachmentLike {
  id: string
  name: string
  kind: 'image' | 'file'
  path: string
  size?: number
}

defineProps<{ attachments: AttachmentLike[] }>()

/** 加载失败的图退化成文件卡：文件可能已被移动，别在气泡里留破图。 */
const broken = ref<Record<string, boolean>>({})
const preview = ref<AttachmentLike | null>(null)

function srcOf(a: AttachmentLike): string {
  // 浏览器模式没有 asset 协议，直接用路径只为可测；真正预览在桌面端。
  return IN_TAURI ? convertFileSrc(a.path) : a.path
}
</script>

<template>
  <div class="msg-attach">
    <template v-for="a in attachments" :key="a.id">
      <button
        v-if="a.kind === 'image' && !broken[a.id]"
        type="button"
        class="ma-thumb"
        :title="`${a.name} · ${attachmentMeta(a)}`"
        @click="preview = a"
      >
        <img :src="srcOf(a)" :alt="a.name" @error="broken[a.id] = true" />
      </button>
      <div v-else class="ma-file" :title="a.path">
        <span class="ma-file-icon"><AppIcon :name="attachmentIcon(a.name)" :size="15" /></span>
        <span class="ma-file-body">
          <span class="ma-file-name">{{ a.name }}</span>
          <span class="ma-file-meta">{{ attachmentMeta(a) }}</span>
        </span>
      </div>
    </template>

    <Teleport to="body">
      <div v-if="preview" class="ma-lightbox" @click.self="preview = null">
        <div class="ma-lightbox-card">
          <img :src="srcOf(preview)" :alt="preview.name" />
          <div class="ma-lightbox-foot">
            <span class="ma-lightbox-name">{{ preview.name }}</span>
            <span class="ma-lightbox-meta">{{ attachmentMeta(preview) }}</span>
            <AppButton variant="secondary" size="sm" @click="preview = null">{{ t('关闭') }}</AppButton>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style src="./MessageAttachments.css" scoped></style>
