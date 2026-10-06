<script setup lang="ts">
/**
 * 技能池 / 共享市场（可复用能力的沉淀与安装）。
 * 读取 `agent_skillpool_list`；发布走 `agent_skill_publish`（脱离 Pi 也能发布，
 * 发布的 SKILL.md 会被 Pi 工具 `skill_pool_list`/`skill_pool_install` 读取）。
 */
import { onMounted, ref } from 'vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppModal from '@/components/ui/AppModal.vue'
import AppInput from '@/components/ui/AppInput.vue'
import AppTextarea from '@/components/ui/AppTextarea.vue'
import RuntimeNote from '@/components/runtime/RuntimeNote.vue'
import {
  agentSkillPoolList,
  agentSkillPublish,
  type SkillPoolEntry,
} from '@/composables/useAgentOps'

defineProps<{ embedded?: boolean }>()

const skills = ref<SkillPoolEntry[]>([])
const busy = ref(false)
const status = ref('')
const dialog = ref(false)
const formName = ref('')
const formDesc = ref('')
const formBody = ref('')

const nameValid = (n: string) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(n.trim()) && n.trim().length <= 64

async function refresh() {
  busy.value = true
  status.value = ''
  try {
    skills.value = await agentSkillPoolList()
  } catch (e) {
    status.value = String(e)
  }
  busy.value = false
}

async function submit() {
  const name = formName.value.trim()
  if (!nameValid(name)) {
    status.value = '技能名需小写字母/数字/单连字符且 ≤64'
    return
  }
  if (!formDesc.value.trim()) {
    status.value = '请填写 description'
    return
  }
  try {
    await agentSkillPublish(name, formDesc.value.trim(), formBody.value)
    status.value = `已发布技能「${name}」`
    dialog.value = false
    formName.value = ''
    formDesc.value = ''
    formBody.value = ''
    await refresh()
  } catch (e) {
    status.value = String(e)
  }
}

onMounted(refresh)
</script>

<template>
  <section class="agent-ops skills" :class="{ embedded }">
    <RuntimeNote />

    <header class="aops-head">
      <div class="aops-title">
        <h1>技能市场池</h1>
        <p class="muted">可复用能力（技能 / 工具 / 连接器）集中地。发布的技能会落盘为 <code>SKILL.md</code>，被对话里的 <code>skill_pool_install</code> 安装调用。</p>
      </div>
      <div class="aops-meta">
        <span class="badge">{{ skills.length }} 个技能</span>
        <button class="tool-btn" :disabled="busy" title="刷新" @click="refresh()">
          <AppIcon name="refresh" :size="14" />
        </button>
      </div>
    </header>

    <div class="aops-toolbar">
      <button class="btn primary" @click="dialog = true">
        <AppIcon name="plus" :size="14" /> 发布技能
      </button>
      <span v-if="status" class="aops-status" :class="{ err: status.startsWith('请') || status.startsWith('技能名') }">{{ status }}</span>
    </div>

    <ul v-if="skills.length" class="skill-list">
      <li v-for="s in skills" :key="s.name" class="skill-card">
        <div class="skill-top">
          <AppIcon name="layers" :size="15" />
          <span class="skill-name">{{ s.name }}</span>
        </div>
        <p class="skill-desc">{{ s.description || '（无描述）' }}</p>
      </li>
    </ul>

    <div v-else class="aops-empty">
      <AppIcon name="layers" :size="36" />
      <strong>市场池还是空的</strong>
      <span class="muted">点「发布技能」沉淀第一个可复用能力，或在对话里用 <code>/skills-market</code> 查看。</span>
    </div>

    <AppModal :open="dialog" title="发布技能" size="md" @close="dialog = false">
      <label class="aops-row">
        <span>技能名</span>
        <AppInput v-model="formName" placeholder="例如 pdf-extract" />
      </label>
      <label class="aops-row">
        <span>description</span>
        <AppInput v-model="formDesc" placeholder="一句话描述这个技能做什么" />
      </label>
      <label class="aops-row">
        <span>正文</span>
        <AppTextarea v-model="formBody" placeholder="SKILL.md 正文：用途、用法、依赖..." :rows="6" />
      </label>
      <p class="dialog-hint">命名规则：小写字母 / 数字 / 单连字符，且长度 ≤ 64，例如 <code>pdf-extract</code>。</p>
      <template #footer>
        <button class="aops-plain" @click="dialog = false">取消</button>
        <button class="btn primary" @click="submit()">发布</button>
      </template>
    </AppModal>
  </section>
</template>

<style src="./SkillPoolView.css" scoped></style>
