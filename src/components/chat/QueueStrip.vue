<script setup lang="ts">
/**
 * G6/#69 M7 队列 strip（纯展示层）：composer 上方的插话/排队条目。
 *
 * 内容以内核 queue_update 回推为权威（props 只读），前端零副账；
 * 一切变更（拖拽重排 / ↑↓ / 编辑 / 删除 / 清空）翻译成事件抛给 ChatView，
 * 由那侧的 applyQueueOp 走 clear→快照→变更→重发编排（usePi 非单例，
 * 编排句柄只在 ChatView 的实例里，组件不碰 RPC）。
 *
 * 坐标系 = 扁平索引：steer 段在前（与内核消费顺序 steer→followUp 同序），
 * followUp 段接在其后；跨段拖拽即类型转换（排队项拖进插话段 = 下次注入）。
 * 拖拽态（源/目标）是纯 UI 瞬时态，活在组件内部。
 */
import { computed, ref } from 'vue'
import { t } from '@/i18n'
import type { QueueMutation, QueueState } from '@/composables/piEvents'
import { splitPromptBody } from '@/composables/usePi'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppButton from '@/components/ui/AppButton.vue'

const props = defineProps<{ queue: QueueState }>()

const emit = defineEmits<{
  /** 真变更：重排/删除/编辑提交，走 applyQueueOp 编排 */
  op: [QueueMutation]
  /** 请求打开编辑弹窗（弹窗本体归 ChatView 持有，与回滚确认同一套 AppModal） */
  editOpen: [at: number]
  clear: []
}>()

const queueTotal = computed(() => props.queue.steering.length + props.queue.followUp.length)

/** 段内索引 → 扁平索引。 */
function flatIndexOf(seg: 'steer' | 'followup', i: number): number {
  return seg === 'steer' ? i : props.queue.steering.length + i
}

/** 条目显示文本：剥掉 buildPrompt 的附件/引用标记块，只留正文。 */
function queueLabel(body: string): string {
  return splitPromptBody(body).text
}

const dragFrom = ref<number | null>(null)
const dropAt = ref<number | null>(null)

function onDragStart(at: number) {
  dragFrom.value = at
}
function onDragOver(at: number) {
  dropAt.value = at
}
function onDragEnd() {
  dragFrom.value = null
  dropAt.value = null
}
function onDrop(at: number) {
  const from = dragFrom.value
  onDragEnd()
  if (from === null || from === at) return
  emit('op', { kind: 'move', from, to: at })
}

/** 键盘语义：↑↓ 与拖拽同构，越界由 mutateQueueSnapshot 判 null 兜底。 */
function move(at: number, dir: -1 | 1) {
  emit('op', { kind: 'move', from: at, to: at + dir })
}
</script>

<template>
  <div v-if="queueTotal > 0" class="queue-strip">
    <div v-if="queue.steering.length" class="queue-seg steer">
      <span class="queue-tag">{{ t('插话') }}</span>
      <span class="queue-hint">{{ t('下一轮模型调用前注入') }}</span>
      <span
        v-for="(item, i) in queue.steering"
        :key="'s' + i"
        class="queue-item"
        :class="{
          dragging: dragFrom === flatIndexOf('steer', i),
          'drop-target': dropAt === flatIndexOf('steer', i) && dragFrom !== flatIndexOf('steer', i),
        }"
        :title="queueLabel(item)"
        draggable="true"
        @dragstart="onDragStart(flatIndexOf('steer', i))"
        @dragend="onDragEnd"
        @dragover.prevent="onDragOver(flatIndexOf('steer', i))"
        @drop.prevent="onDrop(flatIndexOf('steer', i))"
      >
        <span class="queue-item-text">{{ queueLabel(item) }}</span>
        <button
          type="button"
          class="queue-act"
          :aria-label="t('上移一条排队消息')"
          :title="t('上移')"
          :disabled="flatIndexOf('steer', i) === 0"
          @click="move(flatIndexOf('steer', i), -1)"
        ><AppIcon name="chevron-up" :size="11" /></button>
        <button
          type="button"
          class="queue-act"
          :aria-label="t('下移一条排队消息')"
          :title="t('下移')"
          :disabled="flatIndexOf('steer', i) >= queueTotal - 1"
          @click="move(flatIndexOf('steer', i), 1)"
        ><AppIcon name="chevron-down" :size="11" /></button>
        <button
          type="button"
          class="queue-act"
          :aria-label="t('编辑排队消息')"
          :title="t('编辑')"
          @click="emit('editOpen', flatIndexOf('steer', i))"
        ><AppIcon name="edit" :size="11" /></button>
        <button
          type="button"
          class="queue-act danger"
          :aria-label="t('删除排队消息')"
          :title="t('删除')"
          @click="emit('op', { kind: 'remove', at: flatIndexOf('steer', i) })"
        ><AppIcon name="close" :size="11" /></button>
      </span>
    </div>
    <div v-if="queue.followUp.length" class="queue-seg followup">
      <span class="queue-tag">{{ t('排队') }}</span>
      <span class="queue-hint">{{ t('本轮结束后执行') }}</span>
      <span
        v-for="(item, i) in queue.followUp"
        :key="'f' + i"
        class="queue-item"
        :class="{
          dragging: dragFrom === flatIndexOf('followup', i),
          'drop-target': dropAt === flatIndexOf('followup', i) && dragFrom !== flatIndexOf('followup', i),
        }"
        :title="queueLabel(item)"
        draggable="true"
        @dragstart="onDragStart(flatIndexOf('followup', i))"
        @dragend="onDragEnd"
        @dragover.prevent="onDragOver(flatIndexOf('followup', i))"
        @drop.prevent="onDrop(flatIndexOf('followup', i))"
      >
        <span class="queue-item-text">{{ queueLabel(item) }}</span>
        <button
          type="button"
          class="queue-act"
          :aria-label="t('上移一条排队消息')"
          :title="t('上移')"
          :disabled="flatIndexOf('followup', i) === 0"
          @click="move(flatIndexOf('followup', i), -1)"
        ><AppIcon name="chevron-up" :size="11" /></button>
        <button
          type="button"
          class="queue-act"
          :aria-label="t('下移一条排队消息')"
          :title="t('下移')"
          :disabled="flatIndexOf('followup', i) >= queueTotal - 1"
          @click="move(flatIndexOf('followup', i), 1)"
        ><AppIcon name="chevron-down" :size="11" /></button>
        <button
          type="button"
          class="queue-act"
          :aria-label="t('编辑排队消息')"
          :title="t('编辑')"
          @click="emit('editOpen', flatIndexOf('followup', i))"
        ><AppIcon name="edit" :size="11" /></button>
        <button
          type="button"
          class="queue-act danger"
          :aria-label="t('删除排队消息')"
          :title="t('删除')"
          @click="emit('op', { kind: 'remove', at: flatIndexOf('followup', i) })"
        ><AppIcon name="close" :size="11" /></button>
      </span>
    </div>
    <AppButton variant="text" class="queue-clear" :title="t('清空队列，被清出的文本恢复回输入框')" @click="emit('clear')">{{ t('清空') }}</AppButton>
  </div>
</template>

<style src="./QueueStrip.css" scoped></style>
