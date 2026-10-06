<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    modelValue: string
    placeholder?: string
    disabled?: boolean
    mono?: boolean
    rows?: number
    spellcheck?: boolean
  }>(),
  { mono: false, rows: 8, spellcheck: false },
)

const emit = defineEmits<{ 'update:modelValue': [string] }>()
</script>

<template>
  <textarea
    class="app-textarea"
    :class="{ mono: props.mono }"
    :value="props.modelValue"
    :placeholder="props.placeholder"
    :disabled="props.disabled"
    :rows="props.rows"
    :spellcheck="props.spellcheck"
    @input="emit('update:modelValue', ($event.target as HTMLTextAreaElement).value)"
  ></textarea>
</template>

<style src="./AppTextarea.css" scoped></style>
