<script setup lang="ts">
import { computed } from 'vue'
import AppCheckbox from '@/components/ui/AppCheckbox.vue'
import AppIcon from '@/components/ui/AppIcon.vue'

/**
 * 运行记录批量操作栏（菜单「批量操作」进入多选态后出现在列表底部）：
 * 全选（公共 AppCheckbox）+ 已选计数 + 置顶 / 归档 / 删除 / 取消。
 *
 * 只发意图不落地写操作——父组件 RunHistory 逐个 invoke run_meta_update。
 */
const props = withDefaults(
  defineProps<{
    /** 当前选中条数。 */
    selectedCount: number
    /** 当前可见总条数（全选的作用域）。 */
    total: number
    /** 是否已全部选中（驱动全选勾态）。 */
    allChecked: boolean
    /** 批量执行中：禁用动作按钮，防重复提交。 */
    running?: boolean
  }>(),
  { running: false },
)

const emit = defineEmits<{
  'toggle-all': []
  pin: []
  archive: []
  delete: []
  cancel: []
}>()

/** 没选中任何记录时，三个写操作全部禁用（取消永远可点）。 */
const noneSelected = computed(() => props.selectedCount === 0)
</script>

<template>
  <div class="bulk-bar" role="toolbar" aria-label="批量操作">
    <AppCheckbox
      class="bulk-all"
      :model-value="allChecked"
      label="全选"
      @update:model-value="emit('toggle-all')"
    />
    <span class="bulk-count">已选 {{ selectedCount }}/{{ total }}</span>
    <span class="bulk-actions">
      <button
        type="button"
        class="bulk-btn"
        :disabled="noneSelected || running"
        title="置顶所选记录"
        @click="emit('pin')"
      >
        <AppIcon name="star" :size="13" />
        <span>置顶</span>
      </button>
      <button
        type="button"
        class="bulk-btn"
        :disabled="noneSelected || running"
        title="归档所选记录"
        @click="emit('archive')"
      >
        <AppIcon name="box" :size="13" />
        <span>归档</span>
      </button>
      <button
        type="button"
        class="bulk-btn danger"
        :disabled="noneSelected || running"
        title="删除所选记录"
        @click="emit('delete')"
      >
        <AppIcon name="trash" :size="13" />
        <span>删除</span>
      </button>
      <button
        type="button"
        class="bulk-btn"
        :disabled="running"
        title="退出批量操作"
        @click="emit('cancel')"
      >
        <AppIcon name="close" :size="13" />
        <span>取消</span>
      </button>
    </span>
  </div>
</template>

<style src="./RunBulkBar.css" scoped></style>
