<script setup>
import { ref } from 'vue'

/*
 * A filesystem path to copy into a terminal: shown whole, selectable with one
 * click, and copied by the button. The clipboard API needs a secure context
 * (the panel is served over HTTPS); where it is refused the text is selected
 * instead, so Ctrl+C still works.
 */
const props = defineProps({ path: { type: String, required: true }, label: { type: String, default: 'Copy path' } })
const copied = ref(false)
const code = ref(null)
let timer = null

function select () {
  const range = document.createRange()
  range.selectNodeContents(code.value)
  const selection = window.getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
}

async function copy () {
  try {
    await navigator.clipboard.writeText(props.path)
    copied.value = true
    clearTimeout(timer)
    timer = setTimeout(() => { copied.value = false }, 1500)
  } catch { select() }
}
</script>

<template>
  <span class="copy-path">
    <code ref="code" class="copy-path__text" :title="path" @click="select">{{ path }}</code>
    <button type="button" class="copy-path__btn" :aria-label="label" :title="copied ? 'Copied' : label" @click="copy">
      <v-icon :icon="copied ? '$checkCircle' : '$copy'" size="14" />
    </button>
  </span>
</template>

<style scoped>
.copy-path { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; min-width: 0; }
.copy-path__text { font-size: 0.75rem; padding: 1px 6px; border-radius: 4px; background: rgba(var(--v-theme-on-surface), 0.06); user-select: all; overflow-wrap: anywhere; min-width: 0; cursor: text; }
.copy-path__btn { display: inline-flex; padding: 2px; border-radius: 4px; opacity: 0.7; }
.copy-path__btn:hover { opacity: 1; background: rgba(var(--v-theme-on-surface), 0.08); }
</style>
