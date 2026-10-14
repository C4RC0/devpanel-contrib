<script setup>
defineProps({ title: { type: String, required: true }, busy: { type: Boolean, default: false } })
defineEmits(['close'])
</script>

<template>
  <header class="dialog-header">
    <h2 class="dialog-header__title">{{ title }}</h2>
    <v-btn icon="$close" variant="text" size="small" aria-label="Close dialog"
           title="Close dialog" :disabled="busy" @click="$emit('close')" />
  </header>
</template>

<style scoped>
.dialog-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 12px 16px 12px 20px; }
.dialog-header__title { min-width: 0; margin: 0; padding: 6px 0; overflow-wrap: anywhere; font-size: 0.9375rem; font-weight: 600; line-height: 1.4; }
.dialog-header .v-btn { flex: none; }
</style>
