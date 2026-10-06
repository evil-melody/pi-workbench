<template>
  <div class="role-switcher">
    <AppSelect
      :model-value="currentId"
      :options="options"
      :disabled="applying"
      placeholder="选择专家角色"
      :width="width ?? '180px'"
      @update:model-value="onPick"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRoles, type Role } from '@/composables/useRoles'
import AppSelect, { type SelectOption } from '@/components/ui/AppSelect.vue'

/** width 可调：对话页头部保留 180px，首页输入框内需要更紧凑的宽度。 */
const props = defineProps<{ root: string; width?: string }>()

const { roles, currentId, applying, load, current, set } = useRoles(() => props.root)
const active = ref<Role | null>(null)

const options = computed<SelectOption[]>(() =>
  (roles.value ?? []).map((r) => ({ value: r.id, label: r.name, hint: r.description })),
)

async function refresh() {
  await load()
  active.value = await current()
  if (active.value) currentId.value = active.value.id
}

async function onPick(id: string) {
  await set(id)
  active.value = (await current()) ?? active.value
}

onMounted(refresh)

watch(
  () => props.root,
  () => refresh(),
)
</script>

<style src="./RoleSwitcher.css" scoped></style>
