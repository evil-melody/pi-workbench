<script setup lang="ts">
import { t } from '@/i18n'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppButton from '@/components/ui/AppButton.vue'
import { attachmentIcon, attachmentMeta } from '@/utils/attachmentMeta'

/**
 * 待发送附件托盘：缩略图/图标 + 文件名 + 元信息 + 移除键。
 *
 * 落地页（ChatHero）与会话态（ChatView）共用同一份形态——拖拽上传 (#66 M10)
 * 在两个界面都要「看得见、删得掉」，样式与结构只此一份（零重复原则）。
 * 已发送气泡里的附件是历史记录（MessageAttachments），语义不同，不共用。
 */
export interface TrayAttachment {
  id: string
  name: string
  kind: 'image' | 'file'
  /** 托管目录里的绝对路径；title 悬停展示去向。 */
  path?: string
  size?: number
  /** webview 里显示本地图需经 convertFileSrc 转成可加载的 src。 */
  src: string
}

defineProps<{ attachments: TrayAttachment[] }>()
const emit = defineEmits<{ remove: [id: string] }>()
</script>

<template>
  <div v-if="attachments.length" class="att-tray">
    <div v-for="a in attachments" :key="a.id" class="att-chip" :class="a.kind">
      <img v-if="a.kind === 'image'" :src="a.src" class="att-thumb" alt="" />
      <AppIcon v-else :name="attachmentIcon(a.name)" :size="16" />
      <span class="att-body">
        <span class="att-name" :title="a.path ?? a.name">{{ a.name }}</span>
        <span class="att-meta">{{ attachmentMeta(a) }}</span>
      </span>
      <AppButton type="button" variant="icon" class="att-x" :title="t('移除附件')" @click="emit('remove', a.id)">
        <AppIcon name="close" :size="12" />
      </AppButton>
    </div>
  </div>
</template>

<style src="./AttachmentTray.css" scoped></style>
