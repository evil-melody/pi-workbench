<script setup lang="ts">
import { onMounted, ref } from 'vue'
import AppIcon from '@/components/ui/AppIcon.vue'
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
  <button
    class="theme-toggle"
    :class="{ collapsed }"
    :title="theme === 'dark' ? '切换到浅色' : '切换到深色'"
    :aria-label="'当前主题：' + (theme === 'dark' ? '深色' : '浅色')"
    @click="flip"
  >
    <AppIcon :name="theme === 'dark' ? 'moon' : 'sun'" :size="15" />
    <span v-if="!collapsed" class="lbl">{{ theme === 'dark' ? '深色' : '浅色' }}</span>
  </button>
</template>

<style src="./ThemeToggle.css" scoped></style>
