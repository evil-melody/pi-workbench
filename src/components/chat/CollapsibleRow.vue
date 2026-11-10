<script setup lang="ts">import { t } from '@/i18n'

import { computed, ref, watch } from 'vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppButton from '@/components/ui/AppButton.vue'

/**
 * 单行折叠条（默认收起，整行可点展开）。
 *
 * Think 行和工具行结构完全一样——图标 + 标题 +「· 摘要」+ 展开体，
 * 各写一份就是重复代码，抽成一个组件，样式也只有 CollapsibleRow.css 一处。
 */
const props = defineProps<{
  /** AppIcon 名。 */
  icon: string
  title: string
  /** 折叠态显示的摘要；为空时不画分隔符。 */
  summary?: string
  /** 摘要缺失时的中性占位（如「无参数」）。 */
  emptyText?: string
  /** 语义配色：'error' = 工具执行失败。 */
  tone?: string
  /**
   * 运行状态（dsh ToolRow 的 `data-state`）：running 行内扫光、error 换状态点。
   * 空串 = 不表达状态（Think 行）。
   */
  state?: string
}>()

/**
 * 状态的可读文案只给读屏器（dsh `.visuallyHidden` span + `role` 语义）：
 * 扫光对视觉正常的人够用，对读屏器是一团空气。
 */
const stateText = computed(() => {
  if (props.state === 'running') return t('运行中')
  if (props.state === 'error') return t('已失败')
  return ''
})

/** 默认折叠：摘要行只为「一眼看到这步做了什么」，细节要主动点开。 */
const open = ref(false)

/**
 * F8：失败行自动展开。报错内容才是用户真正要看的东西，折叠态只留一行错误摘要
 * 等于把它藏起来（relay-agent console 的失败步同样默认展开）。
 * 只在「进入 error」那一刻打开，用户手动收起后不再强行翻开。
 */
watch(
  () => props.state,
  (s, prev) => {
    if (s === 'error' && prev !== 'error') open.value = true
  },
  { immediate: true },
)
</script>

<template>
  <div
    class="crow"
    :class="{ open, 'is-error': tone === 'error' }"
    :data-state="state || undefined"
  >
    <AppButton variant="menu-item" class="crow-head" :aria-expanded="open" @click="open = !open">
      <!-- F3：caret 与图标一起收进 26px rail 列，工具行的节点就落在 turn 竖线上 -->
      <span class="crow-ic">
        <AppIcon name="chevron-right" :size="11" class="crow-caret" />
        <!-- dsh `leadingFor(state, icon)`：error/stopped 用状态点顶掉变体图标，running 保留图标靠扫光 -->
        <span v-if="state === 'error'" class="crow-icon crow-dot" aria-hidden="true" />
        <AppIcon v-else :name="icon" :size="12" class="crow-icon" />
      </span>
      <span class="crow-main">
        <span class="crow-title">{{ title }}</span>
        <template v-if="summary || emptyText">
          <span class="crow-sep" aria-hidden="true" />
          <span class="crow-summary">{{ summary || emptyText }}</span>
        </template>
      </span>
      <span v-if="stateText" class="crow-sr">{{ stateText }}</span>
    </AppButton>
    <div v-if="open" class="crow-body">
      <slot />
    </div>
  </div>
</template>

<style src="./CollapsibleRow.css" scoped></style>
