<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    modelValue: string
    placeholder?: string
    disabled?: boolean
    type?: 'text' | 'password'
    mono?: boolean
  }>(),
  { type: 'text', mono: false },
)

const emit = defineEmits<{ 'update:modelValue': [string] }>()
</script>

<template>
  <input
    class="app-input"
    :class="{ mono: props.mono }"
    :type="props.type"
    :value="props.modelValue"
    :placeholder="props.placeholder"
    :disabled="props.disabled"
    spellcheck="false"
    @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
  />
</template>

<style src="./AppInput.css" scoped></style>
