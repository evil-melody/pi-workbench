<script setup lang="ts">
/**
 * 统一按钮。变体分两类：
 * - 语义色：主操作 / 次操作 / 危险 / 纯图标 / 纯文字
 * - 形态：菜单项 / 标签页 / 卡片 / chip —— 只重置基座对非行内按钮的布局干扰，
 *   几何与配色仍由调用方的页面样式决定；role、aria 属性、tabindex、键盘事件靠 attr 透传。
 * 未定义 size 时沿用 base.css 的默认按钮尺寸，保证迁移时视觉不变。
 */
import { computed, useAttrs } from 'vue'

const props = withDefaults(
  defineProps<{
    variant?:
      | 'primary'
      | 'secondary'
      | 'danger'
      | 'icon'
      | 'text'
      | 'menu-item'
      | 'tab'
      | 'card'
      | 'chip'
    size?: 'sm' | 'md'
    disabled?: boolean
    type?: 'button' | 'submit' | 'reset'
  }>(),
  { variant: 'secondary', size: 'md', type: 'button' },
)

const attrs = useAttrs()

/**
 * 纯图标按钮必须有可读名称：显式 aria-label 优先，
 * 否则退回 title（title 本身也构成可访问名），避免图标按钮对读屏变成空白。
 */
const ariaLabel = computed(() => {
  const explicit = attrs['aria-label']
  if (typeof explicit === 'string' && explicit) return explicit
  return props.variant === 'icon' && typeof attrs.title === 'string' ? attrs.title : undefined
})

</script>

<template>
  <button
    class="app-btn"
    :class="[`v-${props.variant}`, `s-${props.size}`]"
    :type="props.type"
    :disabled="props.disabled"
    :aria-label="ariaLabel"
  >
    <slot />
  </button>
</template>

<!-- 非 scoped：变体选择器保持单类特异度（0,1,0），页面 scoped 样式（带 data-v，0,2,0）
     始终能覆盖，迁移时原视觉不位移。类名统一 app-btn 前缀，不会外泄到其他元素。 -->
<style src="./AppButton.css"></style>
