<script setup lang="ts">
import { t } from '@/i18n'
import { computed, ref } from 'vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppTextarea from '@/components/ui/AppTextarea.vue'
import RoleSwitcher from '@/components/layout/RoleSwitcher.vue'
import ModeSwitcher from '@/components/chat/ModeSwitcher.vue'
// 档位是全局偏好：落地页直接读同一份状态，不再维护本地影子值。
import { thinkingLevel, setThinkingMode } from '@/composables/useThinkingMode'
import ModelSwitcher from '@/components/chat/ModelSwitcher.vue'
import WorkspacePicker from '@/components/chat/WorkspacePicker.vue'
// 走打包器而不是 public/：模板里的静态 `/xxx.png` 会被当项目根路径解析，
// 仓库根一旦出现同名文件就会静默替换掉 public 里的那张。
import mascotUrl from '@/assets/mascot.png'


export interface HeroProject {
  id: string
  name: string
  /** null = 项目还没绑目录（可以先用模板建项目、之后再绑）。 */
  path: string | null
}

const props = defineProps<{
  projects: HeroProject[]
  cwd: string
  /** 父级正在拉起目录选择器（例如「先选目录再发送」的自动流程）。 */
  busy?: boolean
}>()

const emit = defineEmits<{
  send: [text: string]
  'pick-project': [id: string]
  /** 目录已由选择器取得，父级只负责登记为项目。 */
  'pick-directory': [dir: string]
  /** 给已有项目补绑工作目录（项目可能是模板建的、还没有目录）。 */
  'bind-directory': [payload: { id: string; dir: string }]
  'pick-mode': [mode: string]
}>()

type Category = 'office' | 'code' | 'design'

const category = ref<Category>('office')
const draft = ref('')

/** 父级正在选目录时，发送要等一下——否则会把「选完再补发」的顺序打乱。 */
const busy = computed(() => Boolean(props.busy))

/** 模式不是装饰：先落全局档位，再由父级翻译成内核的 thinking level。 */
function pickMode(mode: string) {
  setThinkingMode(mode)
  emit('pick-mode', mode)
}

/**
 * 场景分类。
 *
 * 图标只借用少量色相做区分，选中态一律走全局强调色 ——
 * 首页出现第二套主色（绿/橙）会和侧栏、按钮的强调色打架，看起来像两个产品。
 */
const categories = computed<{ id: Category; label: string; icon: string }[]>(() => [
  { id: 'office', label: t('日常办公'), icon: 'doc' },
  { id: 'code', label: t('代码开发'), icon: 'code' },
  { id: 'design', label: t('设计创意'), icon: 'image' },
])

const skillMap = computed<Record<Category, { text: string; icon: string }[]>>(() => ({
  office: [
    { text: t('文档处理'), icon: 'doc' },
    { text: t('会议纪要'), icon: 'chat' },
    { text: t('邮件撰写'), icon: 'send' },
    { text: t('数据分析'), icon: 'chart' },
    { text: t('PPT 生成'), icon: 'slide' },
    { text: t('表格处理'), icon: 'table' },
    { text: t('周报总结'), icon: 'list' },
    { text: t('知识整理'), icon: 'book' },
  ],
  code: [
    { text: t('代码生成'), icon: 'zap' },
    { text: t('代码审查'), icon: 'eye' },
    { text: t('Bug 修复'), icon: 'refresh' },
    { text: t('重构'), icon: 'layers' },
    { text: t('写测试'), icon: 'check' },
    { text: t('生成文档'), icon: 'doc' },
    { text: t('解释代码'), icon: 'terminal' },
    { text: t('技术调研'), icon: 'search' },
  ],
  design: [
    { text: t('UI 设计'), icon: 'monitor' },
    { text: t('图标生成'), icon: 'sparkles' },
    { text: t('图片处理'), icon: 'image' },
    { text: t('配色方案'), icon: 'sun' },
    { text: t('设计规范'), icon: 'grid' },
    { text: t('原型生成'), icon: 'box' },
    { text: t('海报设计'), icon: 'layout-sidebar' },
    { text: t('插画建议'), icon: 'heart' },
  ],
}))

const skills = computed(() => skillMap.value[category.value])

/**
 * 发送。
 *
 * 没有工作目录时**不再把输入框锁死**（那等于逼用户先去别处点一圈才能打字）：
 * 文字原样交给父级，由父级先拉起目录选择器、登记项目，再把这句发出去 ——
 * 父级活得比本组件久，`cwd` 一变本组件就卸载，「先记下来再补发」只能由父级做。
 */
function submit() {
  const text = draft.value.trim()
  if (!text || busy.value) return
  emit('send', text)
  // 无目录时保留草稿：用户可能取消目录选择，那时这句话还在，不用重打。
  if (props.cwd) draft.value = ''
}

function pickSkill(s: string) {
  draft.value = s + '：'
}

function onKeydown(e: KeyboardEvent) {
  // 中文/日文输入法合成中按回车是「确认候选词」（keyCode 229）：此时发送/清空
  // 会打断 IME 的 run loop（macOS 报 IMKCFRunLoopWakeUpReliable，输入框卡死）。
  // 放行让输入法先把中文提交进 draft，合成结束后的回车才真正发送。
  if (e.isComposing || e.keyCode === 229) return
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    submit()
  }
}
</script>

<template>
  <div class="chat-hero">
    <div class="hero-bg" aria-hidden="true" />
    <div class="hero-glow" aria-hidden="true" />



    <div class="hero-card">
      <div class="hero-brand">
        <div class="hero-art">
          <img class="hero-mascot" :src="mascotUrl" :alt="t('Pi Workbench 吉祥物')" />
        </div>
        <h1 class="hero-title">Pi Workbench</h1>
        <p class="hero-sub">{{ t('选一个工作目录，用一句话把任务交给 Pi') }}</p>
      </div>

      <!--
        工作空间与权限不再占据独立卡片，而是收进输入框底部的操作条：
        上下文（工作目录 / 模型 / 权限）在左，执行控制（思考深度 / 发送）在右。
      -->
      <div class="hero-composer">
        <div class="hero-input-wrap">
          <AppTextarea
            v-model="draft"
            class="hero-input"
            :placeholder="
              cwd
                ? t('今天帮你做些什么？')
                : t('直接描述你的任务 —— 发送时会先让你选一个工作目录')
            "
            :rows="2"
            @keydown="onKeydown"
          />

          <div class="composer-bar">
            <div class="bar-left">
              <!-- 工作目录与项目是同一件事：一个控件里既切项目也挑本地目录 -->
              <WorkspacePicker
                :projects="projects"
                :cwd="cwd"
                :busy="busy"
                @pick-project="emit('pick-project', $event)"
                @pick-directory="emit('pick-directory', $event)"
                @bind-directory="emit('bind-directory', $event)"
              />

              <span class="bar-sep" aria-hidden="true" />

              <!-- 模型：内核只在启动时读模型，所以切换会重启内核 -->
              <div class="bar-chip" :title="t('本轮对话使用的模型（切换会重启内核）')">
                <AppIcon name="cpu" :size="13" />
                <ModelSwitcher width="124px" />
              </div>

              <span class="bar-sep" aria-hidden="true" />

              <!-- 角色是项目级配置：选了项目才能切；没项目时说明白为什么点不动。 -->
              <div class="bar-chip" :title="cwd ? t('默认权限') : t('选择项目后可切换权限')">
                <AppIcon name="user" :size="13" />
                <RoleSwitcher v-if="cwd" :root="cwd" width="100px" />
                <span v-else class="bar-muted">{{ t('默认权限') }}</span>
              </div>
            </div>

            <div class="bar-right">
              <ModeSwitcher :model-value="thinkingLevel" @update:model-value="pickMode" />
              <AppButton
                variant="icon"
                class="hero-send"
                :title="t('发送')"
                :aria-label="t('发送')"
                :disabled="!draft.trim() || busy"
                @click="submit"
              >
                <AppIcon name="send" :size="16" />
              </AppButton>
            </div>
          </div>
        </div>
        <p class="hero-hint">
          <AppIcon name="corner-down-left" :size="11" />{{ t('Enter 发送 · Shift+Enter 换行') }}</p>
      </div>

      <!--
        场景与技能是「输入之后的加速器」，不是导航：放在输入框下面，
        点一下只是把话头填进草稿，用户仍然可以直接打字。
      -->
      <div class="hero-suggest">
        <div class="cat-track">
          <AppButton
            v-for="c in categories"
            :key="c.id"
            variant="secondary"
            class="cat-pill"
            :class="{ on: category === c.id }"
            @click="category = c.id"
          >
            <span class="cat-icon"><AppIcon :name="c.icon" :size="13" /></span>
            <span>{{ c.label }}</span>
          </AppButton>
        </div>

        <div class="hero-skills">
          <AppButton
            v-for="s in skills"
            :key="s.text"
            variant="secondary"
            class="skill-chip"
            @click="pickSkill(s.text)"
          >
            <AppIcon :name="s.icon" :size="12" />
            <span>{{ s.text }}</span>
          </AppButton>
        </div>
      </div>
    </div>
  </div>
</template>

<style src="./ChatHero.css" scoped></style>
