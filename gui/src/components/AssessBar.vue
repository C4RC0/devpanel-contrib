<script setup>
import { formatHms, formatMTokens, usageTokens } from '@/format'
import { computed, ref, watch } from 'vue'

import { api } from '@/api'

/*
 * Assess: what should happen to this issue next, asked of the decision
 * provider (Jev, the default) or of any verified roster model at any effort it
 * supports. Always on screen in the issue card.
 *
 * Assessments are a list, newest first, so several models' answers stand side
 * by side: next step, playbook, priority, duplicate, each with its confidence.
 * Confident answers stand out and become that assessment's proposals, which an
 * operator may confirm; nothing is applied until someone does. The same
 * question put to the same assessor again is read from its record, never paid
 * for twice.
 */

const props = defineProps({
  project: { type: String, required: true },
  issueId: { type: String, required: true },
  archived: { type: Boolean, default: false },
  /** Bumped by the page whenever the issue reloads, so the bar follows it. */
  version: { type: Number, default: 0 }
})
const emit = defineEmits(['changed'])

const data = ref(null)
const asking = ref(false)
const confirming = ref('')
const error = ref('')
const assessor = ref('provider')
const effort = ref(null)

async function load () {
  try { data.value = await api.pregate(props.project, props.issueId); error.value = '' } catch (e) { error.value = e.message }
}
watch(() => [props.project, props.issueId, props.version], load, { immediate: true })

const provider = computed(() => data.value?.assessors?.provider ?? null)
const models = computed(() => data.value?.assessors?.models ?? [])
const chosenModel = computed(() => (assessor.value === 'provider' ? null : models.value.find((m) => m.id === assessor.value) ?? null))
const efforts = computed(() => chosenModel.value?.efforts ?? [])
watch(chosenModel, (m) => { effort.value = m ? (m.efforts.includes(m.defaultEffort) ? m.defaultEffort : m.efforts[0] ?? null) : null })
// No remembered choice: the provider by default, or the first verified model
// when no provider is configured.
watch([provider, models], ([p, list]) => {
  if (assessor.value === 'provider' && !p) assessor.value = list.find((m) => m.verified && !m.heldUntil)?.id ?? 'provider'
}, { immediate: true })

const canAsk = computed(() => !props.archived && (assessor.value === 'provider' ? Boolean(provider.value) : Boolean(chosenModel.value?.verified && !chosenModel.value?.heldUntil)))

async function assess () {
  asking.value = true
  error.value = ''
  try {
    data.value = await api.assessPregate(props.project, props.issueId, assessor.value === 'provider' ? {} : { model: assessor.value, effort: effort.value })
  } catch (e) { error.value = e.message } finally { asking.value = false }
}

async function confirm (key, proposal) {
  if (!window.confirm(`${proposal.title}?\n\nThis is applied as your decision, citing the assessment.`)) return
  confirming.value = `${key}:${proposal.id}`
  error.value = ''
  try {
    await api.confirmPregate(props.project, props.issueId, key, proposal.id)
    emit('changed')
    await load()
  } catch (e) { error.value = e.message } finally { confirming.value = '' }
}

const LABEL = { gate: 'Next', playbook: 'Playbook', priority: 'Priority', workTime: 'Work time', duplicateOf: 'Duplicate of' }
// The work-time bands, by level (server/decisions/triage-shadow.mjs WORK_TIME_BANDS).
const WORK_TIME = ['5–10 min', '10–20 min', '½–1 h', '1–2 h', '2–3 h', '4–5 h', '6 h+']
const shownValue = (x) => (x.id === 'workTime' ? WORK_TIME[x.value] ?? String(x.value) : VALUE[x.value] ?? x.value)
// A work-time answer is a spread over the bands; the tooltip shows it.
const spread = (x) => (x.id === 'workTime' && x.probabilities
  ? Object.entries(x.probabilities).filter(([, p]) => p >= 0.05).map(([k, p]) => `${WORK_TIME[Number(k)] ?? k}: ${Math.round(p * 100)}%`).join(' · ')
  : null)
const VALUE = { continue: 'work on it', 'close-issue': 'close it', 'needs-input': 'ask for more input', none: 'none' }
const pct = (x) => `${Math.round(x * 100)}%`
const who = (r) => (String(r.provider ?? '').startsWith('model:') ? (r.model ?? r.requestedModel) : `${r.provider}${r.model ? ` (${r.model})` : ''}`)
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')
const cost = (r) => [r.latencyMs != null ? formatHms(r.latencyMs) : null, usageTokens(r.usage) != null ? formatMTokens(usageTokens(r.usage)) : null].filter(Boolean).join(' · ') || null

/* Every assessment, newest first: who answered, what, and what it proposes. */
const list = computed(() => (data.value?.assessments ?? []).map(({ record: r, proposals, confirmations }) => ({
  key: r.key,
  who: who(r),
  meta: [when(r.recordedAt), cost(r)].filter(Boolean).join(' · '),
  answered: r.status === 'answered',
  failure: r.failure?.message ?? r.failure?.class ?? null,
  answers: ['gate', 'playbook', 'priority', 'workTime', 'duplicateOf'].map((id) => r.decisions?.[id] ? { id, ...r.decisions[id] } : null).filter(Boolean),
  proposals,
  confirmed: new Set((confirmations ?? []).map((c) => c.proposalId))
})))
const showAll = ref(false)
const shown = computed(() => (showAll.value ? list.value : list.value.slice(0, 5)))
</script>

<template>
  <section class="assess" aria-label="Assess this issue">
    <div class="assess__controls">
      <span class="assess__title">Assess</span>
      <select v-model="assessor" class="assess__select" aria-label="Assessor" :disabled="archived">
        <option v-if="provider" value="provider">{{ provider.title }} · {{ provider.model }}</option>
        <option v-else value="provider" disabled>Decision provider (not configured)</option>
        <option v-for="m in models" :key="m.id" :value="m.id" :disabled="!m.verified || Boolean(m.heldUntil)">
          {{ m.title }}{{ !m.verified ? ' (unverified)' : m.heldUntil ? ` (on hold until ${m.heldUntil.slice(0, 16).replace('T', ' ')})` : '' }}
        </option>
      </select>
      <select v-if="efforts.length" v-model="effort" class="assess__select assess__select--effort" aria-label="Effort" :disabled="archived">
        <option v-for="e in efforts" :key="e" :value="e">{{ e }}</option>
      </select>
      <v-btn size="small" variant="flat" color="primary" :loading="asking" :disabled="!canAsk" @click="assess">
        Assess
      </v-btn>
    </div>

    <p v-if="!list.length" class="assess__none">Not assessed yet. An assessment answers: what next, which playbook, what priority, and whether it duplicates another issue.</p>
    <ol v-else class="assess__list">
      <li v-for="a in shown" :key="a.key" class="assess__row">
        <div class="assess__who"><strong>{{ a.who }}</strong><span class="assess__by">{{ a.meta }}</span></div>
        <div v-if="a.answered" class="assess__result">
          <span v-for="x in a.answers" :key="x.id" class="assess__answer" :class="{ 'assess__answer--sure': x.confident }"
                :title="x.confident ? 'Confident enough to propose' : `Below the ${pct(x.threshold)} threshold: information only`">
            <span class="assess__label">{{ LABEL[x.id] }}</span>
            <strong :title="spread(x) ?? undefined">{{ shownValue(x) }}</strong>
            <span class="assess__pct">{{ pct(x.confidence) }}</span>
          </span>
        </div>
        <div v-else class="assess__fail" :title="a.failure">Failed: {{ a.failure && a.failure.length > 200 ? `${a.failure.slice(0, 200)}…` : a.failure }}</div>
        <div v-if="a.proposals.length" class="assess__proposals">
          <span v-for="p in a.proposals" :key="p.id" class="assess__proposal">
            {{ p.title }}
            <v-chip v-if="a.confirmed.has(p.id)" size="x-small" variant="tonal" color="success">confirmed</v-chip>
            <span v-else-if="!p.confirmable" class="assess__by">· confirmed by starting it</span>
            <v-btn v-else-if="!archived" size="x-small" variant="tonal" color="primary" :loading="confirming === `${a.key}:${p.id}`" @click="confirm(a.key, p)">Confirm</v-btn>
          </span>
        </div>
      </li>
    </ol>
    <button v-if="list.length > 5" type="button" class="assess__more" @click="showAll = !showAll">{{ showAll ? 'Show fewer' : `Show all ${list.length} assessments` }}</button>
    <p v-if="error" class="assess__error">{{ error }}</p>
  </section>
</template>

<style scoped>
.assess { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(var(--v-theme-on-surface), 0.1); font-size: 0.8125rem; }
.assess__controls { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.assess__title { font-weight: 700; margin-right: 2px; }
.assess__select {
  font: inherit; font-size: 0.8125rem; padding: 5px 8px; border-radius: 6px; background: transparent; color: inherit; max-width: 22rem;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.25);
}
.assess__select option { background: rgb(var(--v-theme-surface)); }
.assess__select--effort { max-width: 8rem; }
.assess__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; max-height: 14rem; overflow-y: auto; }
.assess__row { display: grid; grid-template-columns: minmax(11rem, 16rem) minmax(0, 1fr); gap: 2px 12px; align-items: baseline; padding: 6px 0; border-top: 1px dashed rgba(var(--v-theme-on-surface), 0.1); }
.assess__row:first-child { border-top: 0; }
.assess__who { display: flex; flex-direction: column; min-width: 0; overflow-wrap: anywhere; }
.assess__row > .assess__proposals, .assess__row > .assess__fail { grid-column: 2; }
@media (max-width: 700px) { .assess__row { grid-template-columns: minmax(0, 1fr); } .assess__row > .assess__proposals, .assess__row > .assess__fail { grid-column: 1; } }
.assess__more { align-self: flex-start; border: 0; background: none; padding: 0; color: rgb(var(--v-theme-primary)); font: inherit; font-size: 0.75rem; cursor: pointer; }
.assess__result { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; }
.assess__answer {
  display: inline-flex; align-items: baseline; gap: 5px; padding: 2px 9px; border-radius: 999px;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.15); opacity: 0.8;
}
.assess__answer--sure { opacity: 1; border-color: rgba(var(--v-theme-primary), 0.5); background: rgba(var(--v-theme-primary), 0.08); }
.assess__label { opacity: 0.6; }
.assess__pct { font-variant-numeric: tabular-nums; opacity: 0.65; font-size: 0.75rem; }
.assess__by { opacity: 0.55; font-size: 0.75rem; }
.assess__none { opacity: 0.6; }
.assess__fail { color: rgb(var(--v-theme-warning)); }
.assess__proposals { display: flex; flex-wrap: wrap; gap: 6px 16px; }
.assess__proposal { display: inline-flex; align-items: center; gap: 6px; }
.assess__error { color: rgb(var(--v-theme-error)); margin: 0; }
</style>
