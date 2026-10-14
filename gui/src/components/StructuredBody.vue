<script setup>
import { computed, defineComponent, h } from 'vue'

import JsonTree from './JsonTree.vue'
import { markdownNodes } from '@/markdown'
import { segments } from '@/structured-text'

/*
 * Prose and JSON, each shown for what it is: Markdown that keeps the author's
 * line breaks, and JSON as a tree (JsonTree). Used for prompts, responses and
 * any long string inside JSON, so JSON-in-JSON unfolds all the way down.
 */

// `nested`: inside a JSON string, where another shaded box per level would
// only darken and narrow the view.
const props = defineProps({ text: { type: String, default: '' }, nested: { type: Boolean, default: false } })
const parts = computed(() => segments(props.text))
const Prose = defineComponent({
  props: { text: { type: String, default: '' } },
  setup: (p) => () => h('div', { class: 'sb__prose' }, markdownNodes(p.text, { breaks: true }))
})
</script>

<template>
  <div class="sb" :class="{ 'sb--nested': nested }">
    <template v-for="(part, i) in parts" :key="i">
      <Prose v-if="part.type === 'markdown'" :text="part.text" />
      <div v-else class="sb__json"><JsonTree :value="part.value" /></div>
    </template>
  </div>
</template>

<style scoped>
.sb { min-width: 0; }
.sb__prose { min-width: 0; }
.sb__prose > :first-child { margin-top: 0; }
.sb__prose > :last-child { margin-bottom: 0; }
.sb__json {
  margin: 0 0 1em; padding: 8px 10px; border-radius: 6px; overflow-x: auto;
  background: rgba(var(--v-theme-on-surface), 0.04); border: 1px solid rgba(var(--v-theme-on-surface), 0.08);
}
.sb__json:last-child { margin-bottom: 0; }
.sb--nested .sb__json { padding: 0; background: none; border: 0; margin-bottom: 0.5em; }
</style>
