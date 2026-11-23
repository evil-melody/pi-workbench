<script setup lang="ts">
import { t } from '@/i18n'
import { computed, ref } from 'vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppTextarea from '@/components/ui/AppTextarea.vue'
import ComposerShell from '@/components/chat/ComposerShell.vue'
import ComposerPlusMenu from '@/components/chat/ComposerPlusMenu.vue'
import AttachmentTray, { type TrayAttachment } from '@/components/chat/AttachmentTray.vue'
import ModeSwitcher from '@/components/chat/ModeSwitcher.vue'
// 档位是全局偏好：落地页直接读同一份状态，不再维护本地影子值。
import { thinkingLevel, setThinkingMode } from '@/composables/useThinkingMode'
import ModelSwitcher from '@/components/chat/ModelSwitcher.vue'
import WorkspacePicker from '@/components/chat/WorkspacePicker.vue'
import type { WorkMode } from '@/utils/workMode'
import { IN_TAURI } from '@/composables/usePi'
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
  /** 本轮选中的专家（0/1 项，与会话态 composer 共用同一份状态）。 */
  expert?: string[]
  /** 本轮绑定的专家团（0/1 项）：发送时父级转成 team_dispatch 工具指令。 */
  team?: string[]
  /** 工作模式（与会话态共用父级的 workMode）。 */
  mode?: WorkMode
  /** 待发送附件（父级持有：拖拽/选文件都落 ChatView 的托盘，#66 M10 落地页也可见）。 */
  attachments?: TrayAttachment[]
}>()

const emit = defineEmits<{
  send: [text: string]
  'pick-project': [id: string]
  /** 目录已由选择器取得，父级只负责登记为项目。 */
  'pick-directory': [dir: string]
  /** 给已有项目补绑工作目录（项目可能是模板建的、还没有目录）。 */
  'bind-directory': [payload: { id: string; dir: string }]
  'pick-mode': [mode: string]
  'update:expert': [ids: string[]]
  'update:team': [ids: string[]]
  /** 「+」菜单的添加文件：附件能力在父级（落盘/缩略图都在 ChatView）。 */
  attach: []
  /** 托盘移除键：附件状态在父级，这里只发意图。 */
  'remove-attachment': [id: string]
  /** 「+」菜单的工作模式（默认/计划/问答）。 */
  'update:mode': [mode: WorkMode]
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
    { text: t('邮件撰写'), icon: 'mail' },
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

/** 首屏只显示前 4 个 accelerator：8 个 chip 把落地页撑成两行，输入才是主角。 */
const skills = computed(() => skillMap.value[category.value].slice(0, 4))

/**
 * 发送。
 *
 * 没有工作目录时**不再把输入框锁死**（那等于逼用户先去别处点一圈才能打字）：
 * 文字原样交给父级，由父级先拉起目录选择器、登记项目，再把这句发出去 ——
 * 父级活得比本组件久，`cwd` 一变本组件就卸载，「先记下来再补发」只能由父级做。
 * 专家选择与会话态 composer 共用父级的 expertQueue，发出去由父级消费清零。
 *
 * #66 M10：附件也在父级手里，「只拖图不写字」合法（分析这张截图）——
 * 有附件时空草稿同样放行，父级 submitHero 负责把托盘一起下发。
 */
function submit() {
  const text = draft.value.trim()
  if (busy.value) return
  if (!text && !props.attachments?.length) return
  emit('send', text)
  // 无目录时保留草稿：用户可能取消目录选择，那时这句话还在，不用重打。
  if (props.cwd) draft.value = ''
}

function pickSkill(s: string) {
  draft.value = s + '：'
}

/** 「+」菜单技能行回插：斜杠命令进草稿（与会话态同一通道）。 */
function onComposerInsert(text: string) {
  draft.value = draft.value.trim() ? `${draft.value.trim()}\n${text}` : text
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
        <p class="hero-sub">{{ t('用一句话把任务交给 Pi') }}</p>
      </div>

      <!--
        工作空间与权限不再占据独立卡片，而是收进输入框底部的操作条：
        上下文（工作目录 / 模型 / 权限）在左，执行控制（思考深度 / 发送）在右。
      -->
      <div class="hero-composer">
        <ComposerShell class="hero-input-wrap">
          <!-- #66 M10：拖进来的附件在落地页也要看得见、删得掉（与会话态同一组件） -->
          <template #tray>
            <AttachmentTray :attachments="attachments ?? []" @remove="emit('remove-attachment', $event)" />
          </template>
          <AppTextarea
            v-model="draft"
            class="hero-input"
            :placeholder="t('给 Pi 下达编码任务…（可附带图片或文件）')"
            :rows="1"
            auto-grow
            :max-rows="8"
            @keydown="onKeydown"
          />

          <template #left>
            <!-- 工作目录与项目是同一件事：一个控件里既切项目也挑本地目录 -->
            <WorkspacePicker
              :projects="projects"
              :cwd="cwd"
              :busy="busy"
              @pick-project="emit('pick-project', $event)"
              @pick-directory="emit('pick-directory', $event)"
              @bind-directory="emit('bind-directory', $event)"
            />

            <!-- 模型：内核只在启动时读模型，所以切换会重启内核 -->
            <ModelSwitcher compact width="auto" />

            <!-- 1:1 WorkBuddy 召唤形态：+ 号收 添加文件/模式/专家/技能/连接器/角色。
                 之前的独立角色/专家触发器一并取消（状态双源是用户截图病灶）。 -->
            <ComposerPlusMenu
              :cwd="cwd"
              :expert="expert ?? []"
              :team="team ?? []"
              :mode="mode ?? 'agent'"
              :can-attach="IN_TAURI"
              @attach="emit('attach')"
              @insert="onComposerInsert"
              @update:expert="emit('update:expert', $event)"
              @update:team="emit('update:team', $event)"
              @update:mode="emit('update:mode', $event)"
            />
          </template>

          <template #right>
            <div class="bar-right">
              <ModeSwitcher :model-value="thinkingLevel" width="auto" @update:model-value="pickMode" />
              <AppButton
                variant="icon"
                class="hero-send"
                :title="t('发送')"
                :aria-label="t('发送')"
                :disabled="(!draft.trim() && !attachments?.length) || busy"
                @click="submit"
              >
                <AppIcon name="send" :size="16" />
              </AppButton>
            </div>
          </template>
        </ComposerShell>
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
