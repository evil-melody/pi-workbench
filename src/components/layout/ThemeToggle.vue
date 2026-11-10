<script setup lang="ts">
import { t } from '@/i18n'
import { onMounted, ref } from 'vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import AppButton from '@/components/ui/AppButton.vue'
import { currentTheme, toggleTheme, watchSystemTheme } from '@/theme'

defineProps<{ collapsed?: boolean }>()

const theme = ref(currentTheme())

onMounted(() => {
  watchSystemTheme((t) => (theme.value = t))
})

function flip() {
  theme.value = toggleTheme()
}
</script>

<template>
  <AppButton
    variant="text"
    class="theme-toggle"
    :class="{ collapsed }"
    :title="theme === 'dark' ? t('切换到浅色') : t('切换到深色')"
    :aria-label="t('当前主题：') + (theme === 'dark' ? t('深色') : t('浅色'))"
    @click="flip"
  >
    <AppIcon :name="theme === 'dark' ? 'moon' : 'sun'" :size="15" />
    <span v-if="!collapsed" class="lbl">{{ theme === 'dark' ? t('深色') : t('浅色') }}</span>
  </AppButton>
</template>

<style src="./ThemeToggle.css" scoped></style>
