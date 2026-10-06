<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import { PICK_TIMEOUT_NOTE, cancelPendingPick, pickDirectoryGuarded } from '@/composables/useDirPicker'

/**
 * 工作目录选择器：把「项目」与「目录」合成**一个**控件。
 *
 * 之前是项目下拉 + 独立的「换目录」按钮两处入口，语义重叠：
 * 项目本质上就是「某个目录 + 一个名字」，分成两个控件只会让人猜哪个才管用。
 * 这里合成一个 —— 触发器显示当前项目名（未绑定时显示末段路径 / 提示），
 * 菜单里既能切已有项目，也能直接挑本地目录。
 *
 * 菜单用 Teleport 挂到 body：首页 Hero 是 `overflow-y:auto` 的滚动容器，
 * 留在原地会被裁掉（同 AppSelect 曾经踩过的坑）。
 */

export interface PickerProject {
  id: string
  name: string
  /**
   * `null` 是合法状态：用模板建的项目还没绑目录。
   * 菜单必须能原样渲染它 —— 这里曾经因为 `.replace()` 收到 null 直接把
   * 整个菜单的渲染炸掉，表现就是「点触发器没反应」。
   */
  path: string | null
}

const props = defineProps<{
  projects: PickerProject[]
  cwd: string
  /** 父级正在拉起目录选择器（例如「先选目录再发送」），触发器也要显示等待态。 */
  busy?: boolean
}>()

const emit = defineEmits<{
  'pick-project': [id: string]
  'pick-directory': [dir: string]
  /** 给「还没绑目录的项目」补一个目录；父级负责落库再激活。 */
  'bind-directory': [payload: { id: string; dir: string }]
}>()

/** 菜单宽度：够放「项目名 + 一行路径」，同时不超出窄窗口。 */
const MENU_WIDTH = 300

const open = ref(false)
const localPicking = ref(false)
const note = ref('')
const root = ref<HTMLElement | null>(null)
const trigger = ref<HTMLElement | null>(null)
const menu = ref<HTMLElement | null>(null)
const menuStyle = ref<Record<string, string>>({})

const picking = computed(() => localPicking.value || Boolean(props.busy))
const current = computed(
  () => props.projects.find((p) => Boolean(p.path) && p.path === props.cwd) ?? null,
)

/** 末两段路径：完整路径太长，放 title 与菜单里就够。项目未绑目录时 path 是 null。 */
function shortPath(p?: string | null): string {
  const parts = (p ?? '').replace(/\\/g, '/').split('/').filter(Boolean)
  if (!parts.length) return ''
  return parts.slice(-2).join('/')
}

const label = computed(() => {
  if (picking.value) return '正在选择…'
  if (current.value) return current.value.name
  if (!props.cwd) return '选择工作目录'
  return shortPath(props.cwd)
})

/** 未绑定目录时用虚线描边：把它变成「先做这件事」的入口，而不是又一个灰按钮。 */
const emphasises = computed(() => !props.cwd && !picking.value)

function close() {
  open.value = false
  note.value = ''
}

function toggle() {
  if (picking.value) return
  open.value = !open.value
  if (open.value) {
    note.value = ''
    // 菜单是 Teleport 出去的固定定位元素：不给它算坐标，它就会落在页面末尾
    // （`position:fixed` 无偏移时按静态位置摆放）——「看得见」不等于「在屏内」。
    void nextTick(place)
  }
}

/** 菜单定位：优先向下展开，底部空间不够时向上，横向夹在视口内。 */
function place() {
  const el = trigger.value
  if (!el) return
  const r = el.getBoundingClientRect()
  const width = Math.min(MENU_WIDTH, window.innerWidth - 24)
  const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - width - 8))
  const below = r.bottom + 8
  const fits = window.innerHeight - below > 260
  menuStyle.value = {
    left: `${left}px`,
    width: `${width}px`,
    ...(fits ? { top: `${below}px` } : { bottom: `${window.innerHeight - r.top + 6}px` }),
  }
}

/**
 * 选中一个项目。
 *
 * 已绑目录 → 请求切换；没绑目录 → **就地拉起目录选择器把它绑上**，
 * 而不是静默返回（那正是「点了没反应」的另一半原因）。
 */
async function pickProject(p: PickerProject) {
  if (!p.path) {
    await pickLocal(p)
    return
  }
  close()
  if (p.path === props.cwd) return
  emit('pick-project', p.id)
}

/**
 * 目录选择。`target` 为空 = 新建「本地目录」项目；否则是给已有项目补绑目录。
 * 两条路只差一个事件，选择器打开的等待态与取消出口完全共用。
 */
async function pickLocal(target?: PickerProject) {
  if (picking.value) return
  localPicking.value = true
  note.value = ''
  try {
    const { dir, timedOut } = await pickDirectoryGuarded()
    if (timedOut) {
      note.value = PICK_TIMEOUT_NOTE
      return
    }
    if (!dir) {
      note.value = '没有选择目录。'
      return
    }
    close()
    if (target) emit('bind-directory', { id: target.id, dir })
    else emit('pick-directory', dir)
  } finally {
    localPicking.value = false
  }
}

/** 手动取消等待：迟到的结果会被代际丢弃，不用等系统选择器自己回来。 */
function cancelPick() {
  cancelPendingPick()
  localPicking.value = false
  note.value = '已取消等待目录选择器。'
}

function onDocClick(e: MouseEvent) {
  // 等待期间不收起：菜单收起就等于把「取消」出口和提示一起藏了
  // （点击动作行本身也会冒泡到这里，而那个按钮此刻已经被替换成等待态、不在 DOM 里）。
  if (picking.value) return
  const t = e.target as Node
  if (root.value?.contains(t) || menu.value?.contains(t)) return
  close()
}

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  // 等待中选择 Esc = 放弃等待（保留菜单，好让提示看得见），而不是把出口一起收走。
  if (picking.value && localPicking.value) {
    cancelPick()
    return
  }
  if (open.value) close()
}

function onViewport() {
  if (open.value) place()
}

onMounted(() => {
  document.addEventListener('click', onDocClick)
  document.addEventListener('keydown', onKey)
  window.addEventListener('resize', onViewport)
  window.addEventListener('scroll', onViewport, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', onViewport)
  window.removeEventListener('scroll', onViewport, true)
})

// 目录一就位（无论谁改的）就把菜单收起来，避免菜单浮在已经切走的界面上。
watch(
  () => props.cwd,
  () => close(),
)
</script>

<template>
  <div ref="root" class="ws-picker">
    <button
      ref="trigger"
      type="button"
      class="ws-trigger"
      :class="{ open, emphasis: emphasises }"
      :disabled="picking"
      :title="cwd ? `工作目录：${cwd}` : '选择本地目录作为工作目录'"
      @click="toggle"
    >
      <AppIcon name="folder-open" :size="13" />
      <span class="ws-label">{{ label }}</span>
      <span v-if="!picking" class="ws-caret" aria-hidden="true">▾</span>
    </button>

    <Teleport to="body">
      <div v-if="open" ref="menu" class="ws-menu" :style="menuStyle" role="listbox">
        <p class="ws-menu-title">工作目录</p>

        <button
          v-for="p in projects"
          :key="p.id"
          type="button"
          class="ws-opt"
          :class="{ on: p.path === cwd }"
          role="option"
          :aria-selected="p.path === cwd"
          @click="pickProject(p)"
        >
          <span class="ws-opt-main">
            <span class="ws-opt-name">{{ p.name }}</span>
            <span class="ws-opt-path" :class="{ warn: !p.path }">
              {{ shortPath(p.path) || '未绑定目录 · 点此选择文件夹' }}
            </span>
          </span>
          <AppIcon v-if="p.path === cwd" name="check" :size="13" />
        </button>

        <p v-if="!projects.length" class="ws-empty">还没有项目，直接挑一个本地目录即可。</p>

        <div class="ws-divider" aria-hidden="true" />

        <button v-if="!picking" type="button" class="ws-opt action" @click="pickLocal()">
          <span class="ws-opt-main">
            <span class="ws-opt-name">选择本地目录…</span>
            <span class="ws-opt-path">挑一个文件夹作为工作目录</span>
          </span>
          <AppIcon name="folder" :size="13" />
        </button>

        <div v-else class="ws-pending">
          <span class="ws-opt-name">正在等待系统目录选择器…</span>
          <button type="button" class="ws-cancel" @click="cancelPick">取消</button>
        </div>

        <p v-if="note" class="ws-note">{{ note }}</p>
      </div>
    </Teleport>
  </div>
</template>

<style src="./WorkspacePicker.css" scoped></style>
