<script setup>
import { computed, defineComponent, h, ref, watch } from 'vue'
import { markdownNodes } from '@/markdown'
import StructuredBody from './StructuredBody.vue'

/*
 * `structured`: the text is agent material — prose mixed with JSON, JSON inside
 * JSON strings. The formatted view then keeps line breaks and shows JSON as a
 * tree (StructuredBody); Raw text is still the exact bytes.
 */
const props = defineProps({ text: { type: String, default: '' }, compact: { type: Boolean, default: false }, structured: { type: Boolean, default: false } })
const raw = ref(false)
watch(() => props.text, () => { raw.value = false })
const rendered = computed(() => props.structured ? [] : markdownNodes(props.text))
const Content = defineComponent({ setup: () => () => h('div', { class: 'markdown-content' },
  props.structured ? [h(StructuredBody, { text: props.text })] : rendered.value) })
</script>

<template>
  <section class="markdown-view" :class="{ compact, structured }">
    <div v-if="!compact" class="markdown-controls" role="group" aria-label="Text display">
      <button type="button" :aria-pressed="!raw" @click="raw = false">Formatted</button>
      <button type="button" :aria-pressed="raw" @click="raw = true">Raw text</button>
    </div>
    <pre v-if="raw" class="markdown-raw" tabindex="0">{{ text }}</pre>
    <Content v-else />
  </section>
</template>

<style scoped>
.markdown-view { min-width: 0; }
.markdown-controls { display: flex; justify-content: flex-end; gap: 2px; margin: 0 0 6px; }
.markdown-controls button { font: inherit; font-size: 0.75rem; color: inherit; border-radius: 5px; padding: 5px 9px; opacity: 0.6; }
.markdown-controls button[aria-pressed="true"] { opacity: 1; background: rgba(var(--v-theme-primary), 0.12); color: rgb(var(--v-theme-primary)); }
.markdown-controls button:focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 2px; }
.markdown-raw, :deep(.markdown-content) { padding: 14px 16px; border-radius: 8px; max-height: 60vh; overflow: auto; background: rgb(var(--v-theme-surface-variant)); color: rgb(var(--v-theme-on-surface-variant)); overflow-wrap: anywhere; }
.markdown-raw { margin: 0; white-space: pre-wrap; font: 0.8125rem/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
:deep(.markdown-content) { font-size: 0.875rem; line-height: 1.65; }
:deep(.markdown-content > :first-child) { margin-top: 0; }
:deep(.markdown-content > :last-child) { margin-bottom: 0; }
:deep(.markdown-content p), :deep(.markdown-content ul), :deep(.markdown-content ol), :deep(.markdown-content blockquote), :deep(.markdown-content pre), :deep(.markdown-content .markdown-table) { margin: 0 0 1em; }
:deep(.markdown-content h1), :deep(.markdown-content h2), :deep(.markdown-content h3), :deep(.markdown-content h4), :deep(.markdown-content h5), :deep(.markdown-content h6) { line-height: 1.3; margin: 1.25em 0 0.55em; font-weight: 650; }
:deep(.markdown-content h1) { font-size: 1.45rem; }
:deep(.markdown-content h2) { font-size: 1.2rem; }
:deep(.markdown-content h3) { font-size: 1.05rem; }
:deep(.markdown-content ul), :deep(.markdown-content ol) { padding-left: 1.5em; }
:deep(.markdown-content li > ul), :deep(.markdown-content li > ol) { margin-bottom: 0; }
:deep(.markdown-content li + li) { margin-top: 0.25em; }
:deep(.markdown-content blockquote) { border-left: 3px solid rgba(var(--v-theme-primary), 0.5); padding: 0.1em 0 0.1em 1em; }
:deep(.markdown-content code) { font: 0.8125rem/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; background: rgba(var(--v-theme-on-surface), 0.06); padding: 0.1em 0.3em; border-radius: 4px; }
:deep(.markdown-content pre) { padding: 12px; border-radius: 6px; overflow-x: auto; background: rgba(var(--v-theme-on-surface), 0.06); white-space: pre; overflow-wrap: normal; }
:deep(.markdown-content pre code) { background: none; padding: 0; }
:deep(.markdown-content a) { color: rgb(var(--v-theme-primary)); text-decoration: underline; }
:deep(.markdown-content hr) { border: 0; border-top: 1px solid rgba(var(--v-theme-on-surface), 0.2); margin: 1em 0; }
:deep(.markdown-table) { max-width: 100%; overflow-x: auto; }
:deep(.markdown-content table) { border-collapse: collapse; min-width: 100%; }
:deep(.markdown-content th), :deep(.markdown-content td) { border: 1px solid rgba(var(--v-theme-on-surface), 0.18); padding: 6px 10px; text-align: left; }
:deep(.markdown-content th) { font-weight: 600; background: rgba(var(--v-theme-on-surface), 0.04); }
:deep(.markdown-image) { opacity: 0.65; font-style: italic; }
@media (max-width: 480px) { .markdown-raw, :deep(.markdown-content) { padding: 12px; } }
.structured :deep(.markdown-content) { max-height: none; overflow: visible; }
.compact :deep(.markdown-content) { padding: 0; max-height: none; overflow: visible; background: transparent; color: inherit; border-radius: 0; }
</style>
