<script setup lang="ts">
import { computed, ref } from 'vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import { useCtxMenu } from '@/composables/useCtxMenu'
import type { RunRecord } from '@/composables/useReplay'

/**
 * 运行记录行 hover「···」菜单（顺序对齐 WorkBuddy）：
 * 打开 / 置顶 / 重命名 / 分享 → 独立窗口 / 打开文件夹 / 批量操作 →
 * 归档 / 删除。菜单本体用公共 ctx-menu 样式 + Teleport 到 body，
 * 定位与关闭逻辑收口在 useCtxMenu（与侧栏项目菜单同源）。
 *
 * 本组件只发意图（emit），所有写操作由父组件 RunHistory 落地。
 */
const emit = defineEmits<{
  open: [r: RunRecord]
  pin: [r: RunRecord]
  rename: [r: RunRecord]
  share: [r: RunRecord]
  window: [r: RunRecord]
  folder: [r: RunRecord]
  bulk: []
  archive: [r: RunRecord]
  delete: [r: RunRecord]
}>()

const target = ref<RunRecord | null>(null)
const { open: menuOpen, style: menuStyle, openAt, close } = useCtxMenu(188)

/** 当前菜单对应的记录（打开期间非空；模板先过 menuOpen 闸再用 item）。 */
const item = computed(() => target.value)

/** 由父组件在「···」点击时调用：记录 + 锚点行元素。 */
function open(r: RunRecord, anchor: HTMLElement) {
  target.value = r
  openAt(anchor)
}

/** 记录类菜单项（payload 均为 RunRecord）的统一出口：发意图 → 关菜单。 */
type MenuAction = 'open' | 'pin' | 'rename' | 'share' | 'window' | 'folder' | 'archive' | 'delete'

const ACTIONS: Record<MenuAction, (r: RunRecord) => void> = {
  open: (r) => emit('open', r),
  pin: (r) => emit('pin', r),
  rename: (r) => emit('rename', r),
  share: (r) => emit('share', r),
  window: (r) => emit('window', r),
  folder: (r) => emit('folder', r),
  archive: (r) => emit('archive', r),
  delete: (r) => emit('delete', r),
}

function pick(action: MenuAction) {
  const r = item.value
  if (r) ACTIONS[action](r)
  close()
}

defineExpose({ open, close })
</script>

<template>
  <Teleport to="body">
    <div v-if="menuOpen && item" class="ctx-menu" :style="menuStyle" role="menu">
      <button
        type="button"
        class="ctx-menu-item"
        role="menuitem"
        @click="pick('open')"
      >
        <AppIcon name="history" :size="15" />
        <span>打开这条记录</span>
      </button>
      <button
        type="button"
        class="ctx-menu-item"
        role="menuitem"
        @click="pick('pin')"
      >
        <AppIcon name="star" :size="15" />
        <span>{{ item!.pinned ? '取消置顶' : '置顶' }}</span>
      </button>
      <button
        type="button"
        class="ctx-menu-item"
        role="menuitem"
        @click="pick('rename')"
      >
        <AppIcon name="edit" :size="15" />
        <span>重命名</span>
      </button>
      <button
        type="button"
        class="ctx-menu-item"
        role="menuitem"
        @click="pick('share')"
      >
        <AppIcon name="copy" :size="15" />
        <span>分享任务</span>
      </button>
      <div class="ctx-menu-sep" role="separator"></div>
      <button
        type="button"
        class="ctx-menu-item"
        role="menuitem"
        @click="pick('window')"
      >
        <AppIcon name="external" :size="15" />
        <span>在独立窗口中打开</span>
      </button>
      <button
        type="button"
        class="ctx-menu-item"
        role="menuitem"
        @click="pick('folder')"
      >
        <AppIcon name="folder-open" :size="15" />
        <span>打开文件夹</span>
      </button>
      <button
        type="button"
        class="ctx-menu-item"
        role="menuitem"
        @click="emit('bulk'); close()"
      >
        <AppIcon name="list" :size="15" />
        <span>批量操作</span>
      </button>
      <div class="ctx-menu-sep" role="separator"></div>
      <button
        type="button"
        class="ctx-menu-item"
        role="menuitem"
        @click="pick('archive')"
      >
        <AppIcon name="box" :size="15" />
        <span>{{ item!.archived ? '取消归档' : '归档' }}</span>
      </button>
      <button
        type="button"
        class="ctx-menu-item danger"
        role="menuitem"
        @click="pick('delete')"
      >
        <AppIcon name="trash" :size="15" />
        <span>删除任务</span>
      </button>
    </div>
  </Teleport>
</template>

<style src="@/components/ui/ContextMenu.css" scoped></style>
