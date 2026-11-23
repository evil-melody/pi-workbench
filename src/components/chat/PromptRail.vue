<script setup lang="ts">
import { t } from '@/i18n'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { fmtClock } from '@/utils/timeAgo'

/**
 * #68 M6 提问导航刻度条（对齐 WorkBuddy 右侧竖条）：
 *
 * - 每刻度 = 一条 user 提问；当前所在（视口折算的 activeId）更长更深。
 * - hover 刻度列或顶栏「历史提问」按钮 → 展开提问列表（只显示提问、过长截断）。
 * - 点刻度或列表项 → 定位到那条提问。
 * - 双阈值：提问 ≥ MIN_PROMPTS 轮才出现；宿主对话区太窄（< MIN_WIDTH）隐藏。
 *   列表展开不受轮数阈值约束——两条提问的会话弹一份列表也成立，
 *   阈值管的是「常驻刻度列值不值得占一条竖排」。
 *
 * 宽度判定量宿主（.center）而不是自己：fixed 浮层的父链宽度不可靠，
 * ResizeObserver 挂在宿主上，拉窗即时重算。哨兵常驻（v-show 而非 v-if）：
 * 「先窄后宽」的窗口里，v-if 会把组件整个卸载，观察者跟着没了——
 * 变宽的事件永远不会发生。
 */
const props = defineProps<{
  /** 提问清单（id/text/ts），ChatView 从 messages 折算。 */
  prompts: { id: string; text: string; ts?: number }[]
  /** 当前视口所在提问的 id（MessageList 滚动折算）。 */
  activeId: string | null
  /** 宿主元素（.center）：宽度阈值量它。null = 尚未就位，不观察。 */
  host: HTMLElement | null
  /** 顶栏「历史提问」按钮驱动的外部展开态（与 hover 或关系）。 */
  open?: boolean
}>()

const emit = defineEmits<{
  jump: [id: string]
  'update:open': [boolean]
}>()

const MIN_PROMPTS = 4
const MIN_WIDTH = 560

const hovering = ref(false)
const hostWidth = ref(0)
let ro: ResizeObserver | null = null
let observed: HTMLElement | null = null

watch(
  () => props.host,
  (el) => {
    ro?.disconnect()
    ro = null
    observed = null
    if (!el) return
    // 首读与观察解耦：没有 ResizeObserver 的环境（jsdom/老浏览器）宽度仍读得到，
    // 只是失去动态重算——静态环境本来也不会变宽。
    hostWidth.value = el.getBoundingClientRect().width
    if (typeof ResizeObserver === 'undefined') return
    ro = new ResizeObserver((entries) => {
      for (const e of entries) hostWidth.value = e.contentRect.width
    })
    ro.observe(el)
    observed = el
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  ro?.disconnect()
  ro = null
})

const expanded = computed(() => hovering.value || !!props.open)
const railVisible = computed(
  () => props.prompts.length >= MIN_PROMPTS && hostWidth.value >= MIN_WIDTH,
)

/** 列表项时间：当天只给时分，跨日给月日（fmtClock 三档口径，无 ts 就空）。 */
function itemClock(ts?: number): string {
  return ts ? fmtClock(ts) : ''
}

function jump(id: string) {
  emit('jump', id)
  // 点列表项跳转后收起列表：导航完成，浮层留着挡正文。
  // hover 态一并清掉——列表是 rail 根的 DOM 子节点（指针从刻度爬进列表不算
  // 移出），点击瞬间指针必然悬在浮层里、hovering 已置真；只落 open 不清 hover，
  // C2 入口点完就是假收起。点击本身是「让位」意图，两个来源一起收。
  if (props.open) {
    hovering.value = false
    emit('update:open', false)
  }
}

/** 列表按最新在下呈现（与消息流同序，倒排会让「最上面=最近」的直觉打架）。 */
const ordered = computed(() => props.prompts)

const listRef = ref<HTMLElement | null>(null)
watch(expanded, (on) => {
  if (!on) return
  // 展开时把当前项滚进视野：长会话里高亮项可能在列表窗外
  requestAnimationFrame(() => {
    listRef.value
      ?.querySelector('.pr-item.active')
      ?.scrollIntoView({ block: 'nearest' })
  })
})
</script>

<template>
  <!--
    哨兵常驻：根容器永远挂载（v-show 语义交给内层刻度列），ResizeObserver 活着，
    「先窄后宽」的窗口拉宽后阈值即时重算。零尺寸时不拦任何点击。
  -->
  <div class="prompt-rail" @mouseenter="hovering = true" @mouseleave="hovering = false">
    <!-- 刻度列：双阈值（≥4 轮 + 容器够宽）才常驻 -->
    <template v-if="railVisible">
      <button
        v-for="p in ordered"
        :key="p.id"
        type="button"
        class="pr-tick"
        :class="{ active: p.id === activeId }"
        :title="p.text"
        :aria-label="t('跳转到提问：{0}', [p.text.slice(0, 24)])"
        @click="jump(p.id)"
      />
    </template>
    <!-- 提问列表：hover / 顶栏入口展开；不受轮数阈值约束——两条提问弹一份
         列表也成立，阈值管的是「常驻刻度列值不值得占一条竖排」。 -->
    <div v-if="expanded && ordered.length" ref="listRef" class="pr-list" role="navigation" :aria-label="t('历史提问')">
      <p class="pr-list-head">{{ t('历史提问') }}<span class="pr-list-count">{{ t('{0} 条', [ordered.length]) }}</span></p>
      <button
        v-for="p in ordered"
        :key="p.id"
        type="button"
        class="pr-item"
        :class="{ active: p.id === activeId }"
        @click="jump(p.id)"
      >
        <span class="pr-item-text">{{ p.text || t('（无正文）') }}</span>
        <span v-if="itemClock(p.ts)" class="pr-item-clock">{{ itemClock(p.ts) }}</span>
      </button>
    </div>
  </div>
</template>

<style src="./PromptRail.css" scoped></style>
