<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'

import { followPanel, panel } from '@/panel-status'
import { formatDuration, formatHms, formatMTokens, formatStep } from '@/format'

/*
 * Two chips in the app bar, readable at a glance and without words:
 *
 *   [supervisor ▶]        on (pulsing while it thinks), ■ stopped, ⚠ needs recovery
 *   [robot ▶3 ⏸1 ■2]      agents working · waiting · stopped and needing a person
 *
 * A state with nothing in it is not shown, and a count of one is just the icon.
 * Each chip opens a dropdown that says the same thing in words, with links.
 */

let stop = null
const now = ref(Date.now())
let clock = null
onMounted(() => { stop = followPanel(); clock = setInterval(() => { now.value = Date.now() }, 1000) })
onUnmounted(() => { stop?.(); clearInterval(clock) })

const shortProject = (p) => String(p).replace(/-project$/, '')
const since = (iso) => {
  now.value // tick
  return iso ? formatDuration(Math.max(0, Math.round((now.value - Date.parse(iso)) / 1000))) : ''
}
const runLink = (project, issueId, runId) => ({ path: `/projects/${project}/${issueId}`, query: runId ? { run: runId } : {} })

// ------------------------------------------------------------------ agents
const running = computed(() => panel.runs.filter((r) => r.ownership !== 'unowned' && r.agents?.length).map((r) => ({
  key: r.runId,
  to: runLink(r.project, r.issueId, r.runId),
  title: r.agents.map((a) => a.role).join(' · '),
  model: r.agents.length === 1 ? r.agents[0].model : null,
  sub: `${shortProject(r.project)} · ${r.issueName ?? r.issueId}`,
  detail: r.agents.map((a) => `${a.role}: ${[a.model, a.stepId && formatStep(a.stepId, a.role)].filter(Boolean).join(', ')}`).join('\n'),
  startedAt: r.agents.map((a) => a.startedAt).filter(Boolean).sort()[0] ?? null,
  count: r.agents.length
})))
const WAITING = { question: 'waiting for your answer', paused: 'paused' }
const waiting = computed(() => [
  ...panel.runs.filter((r) => r.ownership !== 'unowned' && !r.agents?.length).map((r) => ({
    key: r.runId, to: runLink(r.project, r.issueId, r.runId),
    title: r.status === 'preflighting' ? 'starting' : 'between turns', sub: `${shortProject(r.project)} · ${r.issueName ?? r.issueId}`, startedAt: null
  })),
  ...panel.attention.filter((a) => WAITING[a.kind]).map((a) => ({
    key: `${a.project}/${a.issueId}/${a.runId}`, to: runLink(a.project, a.issueId, a.runId),
    title: a.headline ?? WAITING[a.kind], sub: `${shortProject(a.project)} · ${a.issueName}`, startedAt: a.since
  }))
])
const STOPPED = { blocked: 'blocked', failed: 'failed', recovery: 'needs recovery' }
const stopped = computed(() => [
  ...panel.runs.filter((r) => r.ownership === 'unowned').map((r) => ({
    key: r.runId, to: runLink(r.project, r.issueId, r.runId),
    title: 'no process owns this run', sub: `${shortProject(r.project)} · ${r.issueName ?? r.issueId}`, startedAt: null
  })),
  ...panel.attention.filter((a) => STOPPED[a.kind]).map((a) => ({
    key: `${a.project}/${a.issueId}/${a.runId}`, to: runLink(a.project, a.issueId, a.runId),
    title: a.headline ?? STOPPED[a.kind], sub: `${shortProject(a.project)} · ${a.issueName}`, startedAt: a.since
  }))
])
const agentCount = computed(() => running.value.reduce((n, r) => n + r.count, 0))
const agentsLabel = computed(() => [
  agentCount.value && `${agentCount.value} agent${agentCount.value === 1 ? '' : 's'} working`,
  waiting.value.length && `${waiting.value.length} waiting`,
  stopped.value.length && `${stopped.value.length} stopped and needing a person`
].filter(Boolean).join(', ') || 'No agents running')

// -------------------------------------------------------------- supervisor
const sup = computed(() => panel.supervisor)
const supState = computed(() => {
  const s = sup.value
  if (!s) return { icon: '$stop', tone: 'off', words: 'Supervisor: unknown' }
  if (s.status === 'recovery-required') return { icon: '$alertCircle', tone: 'warn', words: 'Supervisor needs recovery' }
  if (s.status === 'working') return { icon: '$play', tone: 'busy', words: 'Supervisor is thinking' }
  if (s.finishing || s.status === 'stopping' || s.status === 'finishing') return { icon: '$stop', tone: 'warn', words: 'Supervisor is finishing' }
  if (s.status === 'active') return { icon: '$play', tone: 'on', words: 'Supervisor is on, waiting for events' }
  return { icon: '$stop', tone: 'off', words: 'Supervisor is stopped' }
})
</script>

<template>
  <div class="chips" role="group" aria-label="Panel status">
    <!-- ------------------------------------------------------ supervisor -->
    <v-menu location="bottom" :close-on-content-click="true">
      <template #activator="{ props: menu }">
        <button v-bind="menu" type="button" class="chip" :class="`chip--${supState.tone}`" :aria-label="supState.words" :title="supState.words">
          <v-icon icon="$supervisor" size="18" class="chip__who" />
          <v-icon :icon="supState.icon" size="16" class="chip__state" :class="{ 'chip__state--pulse': supState.tone === 'busy' }" />
        </button>
      </template>
      <v-card class="drop" elevation="6" border>
        <div class="drop__head">
          <v-icon :icon="supState.icon" size="16" :class="`drop__icon--${supState.tone}`" />
          <strong>{{ supState.words }}</strong>
        </div>
        <template v-if="sup">
          <p v-if="sup.model" class="drop__line"><span>Model</span>{{ sup.model }}</p>
          <p v-if="sup.pending" class="drop__line"><span>Doing</span>{{ sup.pending.replace(/-/g, ' ') }}</p>
          <p v-if="sup.reason" class="drop__line"><span>Why</span>{{ sup.reason }}</p>
          <p class="drop__line"><span>This session</span>{{ sup.calls }}<template v-if="sup.limits?.maxCalls"> / {{ sup.limits.maxCalls }}</template> calls · {{ sup.starts }}<template v-if="sup.limits?.maxRuns"> / {{ sup.limits.maxRuns }}</template> starts</p>
          <p v-if="sup.usage" class="drop__line"><span>Model calls</span>{{ formatHms(sup.usage.durationMs) }} · {{ formatMTokens(sup.usage.tokens) }}<template v-if="sup.usage.untimed"> · {{ sup.usage.untimed }} earlier call{{ sup.usage.untimed === 1 ? '' : 's' }} untimed</template></p>
          <p v-if="sup.ownedRuns" class="drop__line"><span>Owns</span>{{ sup.ownedRuns }} run{{ sup.ownedRuns === 1 ? '' : 's' }}</p>
          <div v-if="sup.last?.text" class="drop__quote">
            <span class="drop__quote-when">last said {{ since(sup.last.at) }} ago</span>
            {{ sup.last.text }}
          </div>
        </template>
        <div class="drop__foot"><RouterLink to="/supervisor">Open supervisor</RouterLink></div>
      </v-card>
    </v-menu>

    <!-- ---------------------------------------------------------- agents -->
    <v-menu location="bottom" :close-on-content-click="true">
      <template #activator="{ props: menu }">
        <button v-bind="menu" type="button" class="chip" :class="{ 'chip--off': !agentCount && !waiting.length && !stopped.length }" :aria-label="agentsLabel" :title="agentsLabel">
          <v-icon icon="$robot" size="18" class="chip__who" />
          <span v-if="agentCount" class="chip__count chip__count--busy">
            <v-icon icon="$play" size="16" class="chip__state--pulse" /><b v-if="agentCount > 1">{{ agentCount }}</b>
          </span>
          <span v-if="waiting.length" class="chip__count chip__count--wait">
            <v-icon icon="$pause" size="16" /><b v-if="waiting.length > 1">{{ waiting.length }}</b>
          </span>
          <span v-if="stopped.length" class="chip__count chip__count--stop">
            <v-icon icon="$stop" size="16" /><b v-if="stopped.length > 1">{{ stopped.length }}</b>
          </span>
          <v-icon v-if="!agentCount && !waiting.length && !stopped.length" icon="$stop" size="16" class="chip__state" />
        </button>
      </template>
      <v-card class="drop drop--wide" elevation="6" border>
        <p v-if="!running.length && !waiting.length && !stopped.length" class="drop__empty">No agents are running, and nothing is waiting.</p>

        <template v-for="group in [
          { key: 'run', icon: '$play', tone: 'busy', label: 'Working', items: running },
          { key: 'wait', icon: '$pause', tone: 'wait', label: 'Waiting', items: waiting },
          { key: 'stop', icon: '$stop', tone: 'stop', label: 'Stopped — needs a person', items: stopped }
        ]" :key="group.key">
          <section v-if="group.items.length" class="drop__group">
            <h3 class="drop__label"><v-icon :icon="group.icon" size="14" :class="`drop__icon--${group.tone}`" />{{ group.label }} <span>{{ group.items.length }}</span></h3>
            <RouterLink v-for="i in group.items" :key="i.key" :to="i.to" class="drop__item" :title="i.detail ?? i.title">
              <span class="drop__title">{{ i.title }}<span v-if="i.model" class="drop__model"> · {{ i.model }}</span></span>
              <span v-if="i.startedAt" class="drop__time">{{ since(i.startedAt) }}</span>
              <span class="drop__sub">{{ i.sub }}</span>
            </RouterLink>
          </section>
        </template>
        <div class="drop__foot"><RouterLink to="/">Open dashboard</RouterLink></div>
      </v-card>
    </v-menu>
  </div>
</template>

<style scoped>
.chips { display: flex; align-items: center; gap: 8px; }
.chip {
  display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 10px; border-radius: 999px;
  border: 1px solid rgba(var(--v-theme-on-surface), 0.14); background: rgba(var(--v-theme-on-surface), 0.03);
  color: inherit; font: inherit; cursor: pointer;
}
.chip:hover { background: rgba(var(--v-theme-on-surface), 0.07); }
.chip:focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: 2px; }
.chip__who { opacity: 0.75; }
.chip--off .chip__who, .chip--off .chip__state { opacity: 0.4; }
.chip--on .chip__state, .chip--busy .chip__state { color: rgb(var(--v-theme-success)); }
.chip--warn { border-color: rgba(var(--v-theme-warning), 0.5); }
.chip--warn .chip__state { color: rgb(var(--v-theme-warning)); }
.chip__count { display: inline-flex; align-items: center; gap: 1px; font-size: 0.8125rem; font-variant-numeric: tabular-nums; }
.chip__count b { font-weight: 650; }
.chip__count--busy { color: rgb(var(--v-theme-success)); }
.chip__count--wait { color: rgb(var(--v-theme-info)); }
.chip__count--stop { color: rgb(var(--v-theme-warning)); }
.chip__state--pulse { animation: pulse 1.4s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) { .chip__state--pulse { animation: none; } }

.drop { width: 340px; max-width: calc(100vw - 24px); padding: 12px 14px 10px; font-size: 0.8125rem; }
.drop--wide { width: 420px; }
.drop__head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font-size: 0.875rem; }
.drop__icon--on, .drop__icon--busy { color: rgb(var(--v-theme-success)); }
.drop__icon--wait { color: rgb(var(--v-theme-info)); }
.drop__icon--warn, .drop__icon--stop { color: rgb(var(--v-theme-warning)); }
.drop__icon--off { opacity: 0.5; }
.drop__line { display: flex; gap: 10px; margin: 3px 0; line-height: 1.45; overflow-wrap: anywhere; }
.drop__line > span { flex: none; width: 6.5rem; opacity: 0.55; }
.drop__quote { margin-top: 8px; padding: 6px 10px; border-left: 3px solid rgba(var(--v-theme-primary), 0.4); line-height: 1.5; opacity: 0.9; overflow-wrap: anywhere; }
.drop__quote-when { display: block; font-size: 0.6875rem; opacity: 0.55; margin-bottom: 2px; }
.drop__empty { opacity: 0.6; margin: 4px 0 8px; }
.drop__group + .drop__group { margin-top: 10px; }
.drop__label { display: flex; align-items: center; gap: 6px; font-size: 0.6875rem; font-weight: 650; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.7; margin-bottom: 4px; }
.drop__label span { opacity: 0.6; }
.drop__item {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0 10px; padding: 6px 8px; margin: 0 -8px;
  border-radius: 6px; color: inherit; text-decoration: none;
}
.drop__item:hover, .drop__item:focus-visible { background: rgba(var(--v-theme-on-surface), 0.06); outline: none; }
.drop__title { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.drop__model { font-weight: 400; opacity: 0.6; }
.drop__time { opacity: 0.55; font-variant-numeric: tabular-nums; }
.drop__sub { grid-column: 1 / -1; opacity: 0.6; font-size: 0.75rem; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.drop__foot { margin-top: 10px; padding-top: 8px; border-top: 1px solid rgba(var(--v-theme-on-surface), 0.1); text-align: right; }
.drop__foot a { color: rgb(var(--v-theme-primary)); text-decoration: none; font-weight: 600; }
</style>
