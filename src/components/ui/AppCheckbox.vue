<script setup lang="ts">
const props = defineProps<{ modelValue: boolean; label: string; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [boolean] }>()
</script>

<template>
  <label class="app-check" :class="{ off: props.disabled }">
    <input
      type="checkbox"
      class="native"
      :checked="props.modelValue"
      :disabled="props.disabled"
      @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
    />
    <span class="box" aria-hidden="true"></span>
    <span class="text">{{ props.label }}</span>
  </label>
</template>

<style src="./AppCheckbox.css" scoped></style>
