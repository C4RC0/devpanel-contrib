<script setup>
import { computed, ref } from 'vue'

import { api } from '@/api'
import MarkdownText from './MarkdownText.vue'
import { formatBytes } from '@/format'

/*
 * What is actually in the issue folder, step by step.
 *
 * Markdown files have formatted and raw views; other readable files stay text.
 * Attachments are downloaded with authentication. Source HTML never becomes DOM.
 */

const props = defineProps({
  project: { type: String, required: true },
  issueId: { type: String, required: true },
  steps: { type: Array, default: () => [] }
})

/** Files worth showing in place rather than handing over as a download. */
const READABLE = /\.(md|markdown|txt|log|json|ya?ml|csv|diff|patch|html?|xml|sh|sql)$/i

const opened = ref([])

/*
 * The folder, read run by run: consecutive steps that one run wrote (its turns,
 * its answers, its result) sit under a header naming the run. Steps no run
 * wrote — the report, notes, supervisor notes — stay where they fall.
 */
const runNumber = computed(() => {
  const order = [...new Map(props.steps.filter((st) => st.run).map((st) => [st.run.runId, st.run.startedAt ?? ''])).entries()]
    .sort((x, y) => String(x[1]).localeCompare(String(y[1])))
  return new Map(order.map(([id], i) => [id, i + 1]))
})
const when = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }
const rows = computed(() => {
  const out = []
  let current = null
  for (const step of props.steps) {
    const runId = step.run?.runId ?? null
    if (runId && runId !== current) {
      const members = props.steps.filter((st) => st.run?.runId === runId)
      const turns = members.filter((st) => st.run.kind !== 'result').length
      out.push({ header: true, key: `run:${runId}:${step.number}`, runId, label: `Run ${runNumber.value.get(runId)}`,
        detail: [step.run.playbook, when(step.run.startedAt), `${turns} step${turns === 1 ? '' : 's'}${members.some((st) => st.run.kind === 'result') ? ' + result' : ''}`].filter(Boolean).join(' · ') })
    }
    current = runId
    out.push({ header: false, key: step.id, step, grouped: Boolean(runId) })
  }
  return out
})
const contents = ref({})
const loading = ref({})
const failed = ref({})

const key = (step, file) => `${step.number}/${file.name}`

async function show (step, file) {
  const id = key(step, file)
  if (contents.value[id] || loading.value[id]) return
  loading.value = { ...loading.value, [id]: true }
  try {
    const blob = await api.downloadStepFile(props.project, props.issueId, step.number, file.name)
    contents.value = { ...contents.value, [id]: await blob.text() }
  } catch (err) {
    failed.value = { ...failed.value, [id]: err.message }
  } finally {
    loading.value = { ...loading.value, [id]: false }
  }
}

/** Fetched with the token in a header, then handed over — never a bare link. */
async function download (step, file) {
  const id = key(step, file)
  try {
    const blob = await api.downloadStepFile(props.project, props.issueId, step.number, file.name)
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = file.name
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(url)
  } catch (err) {
    failed.value = { ...failed.value, [id]: err.message }
  }
}

function onOpen (step) {
  for (const file of step.files.filter((f) => !f.directory && READABLE.test(f.name))) show(step, file)
}
</script>

<template>
  <div class="material">
    <p v-if="!steps.length" class="material__empty">
      Nothing in this issue folder yet.
    </p>

    <v-expansion-panels v-model="opened" variant="accordion" multiple class="material__panels">
      <template v-for="row in rows" :key="row.key">
      <v-expansion-panel v-if="row.header" :value="row.key" readonly hide-actions class="material__run">
        <v-expansion-panel-title class="material__run-title">
          <span class="material__run-label">{{ row.label }}</span>
          <span class="material__run-detail">{{ row.detail }}</span>
          <RouterLink class="material__run-link" :to="{ query: { run: row.runId } }" @click.stop>open run</RouterLink>
        </v-expansion-panel-title>
      </v-expansion-panel>
      <v-expansion-panel v-else :value="row.step.id" :class="{ 'material__grouped': row.grouped, 'material__result': row.step.run?.kind === 'result' }" @group:selected="onOpen(row.step)">
        <v-expansion-panel-title class="material__row">
          <span class="material__number">{{ row.step.number }}</span>
          <span class="material__name">{{ row.step.name }}</span>
          <span class="material__count">
            {{ row.step.files.length }} file{{ row.step.files.length === 1 ? '' : 's' }}
          </span>
        </v-expansion-panel-title>

        <v-expansion-panel-text>
          <p v-if="!row.step.files.length" class="material__empty">This step folder is empty.</p>

          <div v-for="file in row.step.files" :key="file.name" class="file">
            <div class="file__head">
              <v-icon :icon="file.directory ? '$folder' : '$file'" size="14" class="file__icon" />
              <span class="file__name">{{ file.name }}</span>
              <span v-if="file.size !== null" class="file__size">{{ formatBytes(file.size) }}</span>
              <v-spacer />
              <v-btn v-if="!file.directory" size="x-small" variant="text"
                     :aria-label="`Download ${file.name}`" @click="download(row.step, file)">
                Download
              </v-btn>
            </div>

            <p v-if="failed[key(row.step, file)]" class="file__error">{{ failed[key(row.step, file)] }}</p>
            <p v-else-if="loading[key(row.step, file)]" class="file__note">Reading…</p>
            <MarkdownText v-else-if="contents[key(row.step, file)] !== undefined && /\.(md|markdown)$/i.test(file.name)" :text="contents[key(row.step, file)]" class="file__markdown" />
            <pre v-else-if="contents[key(row.step, file)] !== undefined" class="file__body">{{ contents[key(row.step, file)] }}</pre>
            <p v-else-if="!file.directory && !READABLE.test(file.name)" class="file__note">
              Offered as a download — the panel does not render attachments.
            </p>
          </div>
        </v-expansion-panel-text>
      </v-expansion-panel>
      </template>
    </v-expansion-panels>
  </div>
</template>

<style scoped>
.material__empty { font-size: 0.8125rem; opacity: 0.55; padding: 10px 4px; }
.material__panels { border-radius: 10px; overflow: hidden; }

.material__row { font-size: 0.875rem; min-height: 46px; }
/* A run's header: not a panel to open, a label over the steps it wrote. */
.material__run :deep(.v-expansion-panel-title) { min-height: 38px; cursor: default; background: rgba(var(--v-theme-primary), 0.06); }
.material__run-title { gap: 10px; font-size: 0.8125rem; }
.material__run-label { font-weight: 700; }
/* Wraps rather than ellipsizes: on a phone the date and step count are the part that would be cut. */
.material__run-detail { opacity: 0.65; min-width: 0; overflow-wrap: anywhere; line-height: 1.35; }
.material__run-link { margin-left: auto; color: rgb(var(--v-theme-primary)); font-weight: 600; text-decoration: none; flex: none; }
.material__grouped :deep(.v-expansion-panel-title) { padding-left: 34px; }
.material__result .material__name { font-weight: 700; }
.material__number { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.75rem; opacity: 0.45; margin-right: 10px; }
.material__name { font-weight: 550; }
.material__count { margin-left: auto; margin-right: 10px; font-size: 0.75rem; opacity: 0.5; }

.file { padding: 6px 0 10px; }
.file__head { display: flex; align-items: center; gap: 8px; }
.file__icon { opacity: 0.5; flex: none; }
.file__name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.8125rem; overflow-wrap: anywhere; }
.file__size { font-size: 0.75rem; opacity: 0.5; }
.file__note { font-size: 0.75rem; opacity: 0.55; margin-top: 4px; }
.file__error { font-size: 0.75rem; color: rgb(var(--v-theme-error)); margin-top: 4px; }

.file__body {
  margin: 6px 0 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8125rem;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: rgb(var(--v-theme-surface-variant));
  color: rgb(var(--v-theme-on-surface-variant));
  padding: 12px 14px;
  border-radius: 8px;
  max-height: 24rem;
  overflow-y: auto;
}
</style>
