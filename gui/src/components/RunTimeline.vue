<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'

import { formatDuration, formatHms, formatMTokens, formatMillis, formatStep, usageTokens } from '@/format'

/*
 * The collaboration, in order.
 *
 * Review rounds and protocol-repair attempts are grouped visually, but every
 * response stays individually selectable — a repair is a restatement of the same
 * turn, not work to be hidden.
 */

const props = defineProps({
  timeline: { type: Array, default: () => [] },
  active: { type: Array, default: () => [] },
  selected: { type: String, default: null }
})

const now = ref(Date.now())
let ticker = null
onMounted(() => { ticker = setInterval(() => { now.value = Date.now() }, 1000) })
onUnmounted(() => clearInterval(ticker))
const since = (iso) => { now.value; return formatDuration(Math.max(0, Math.round((now.value - Date.parse(iso)) / 1000))) }
/* "thinking" is an activity indication, not progress: it says the runtime is
   working, nothing about how near the answer is. */
const activityLabel = (a) => (a.lastKind === 'tool-use' && a.lastDetail ? `using ${a.lastDetail}` : a.lastKind === 'system' && /thinking/.test(a.lastDetail ?? '') ? 'thinking' : (a.lastKind ?? 'active').replace(/-/g, ' '))

defineEmits(['select'])

const ROLE_ICON = { coordinator: '$dashboard', author: '$chip', auditor: '$issues' }

/** Consecutive turns of the same phase and round belong together. */
const groups = computed(() => {
  const out = []
  for (const turn of props.timeline) {
    const last = out.at(-1)
    if (last && last.phase === turn.phase && last.round === turn.round) last.turns.push(turn)
    else out.push({ phase: turn.phase, round: turn.round, turns: [turn] })
  }
  return out
})

const groupLabel = (g) => {
  const rounds = props.timeline.filter((t) => t.phase === g.phase).map((t) => t.round)
  return new Set(rounds).size > 1 ? `${g.phase} · round ${g.round + 1}` : g.phase
}

const verdictColour = (turn) =>
  turn.verdict === 'approved' ? 'success' : turn.verdict === 'changes-needed' ? 'warning' : undefined

const substantial = (turn) =>
  (turn.findings ?? []).filter((f) => f.blocking || f.severity === 'major' || f.severity === 'critical').length

/** How long the agent took. Unknown for work adopted after a restart. */
const took = (turn) => formatHms(turn.timing?.durationMs ?? null)
</script>

<template>
  <div class="timeline">
    <section v-for="(group, gi) in groups" :key="`${group.phase}-${group.round}-${gi}`" class="group">
      <header class="group__head">
        <span class="group__label">{{ groupLabel(group) }}</span>
        <span class="group__rule" />
      </header>

      <button
        v-for="turn in group.turns"
        :key="turn.number"
        type="button"
        class="turn"
        :class="{
          'turn--selected': selected === turn.number,
          'turn--repair': turn.isRepair,
          'turn--invalid': turn.output && turn.output.valid === false
        }"
        @click="$emit('select', turn.number)"
      >
        <span class="turn__number">{{ turn.number }}</span>
        <v-icon :icon="ROLE_ICON[turn.role] ?? '$shape'" size="15" class="turn__icon" />

        <span class="turn__body">
          <span class="turn__title">
            {{ formatStep(turn.stepId, turn.role) }}
            <span v-if="turn.isRepair" class="turn__tag turn__tag--repair">
              restated · attempt {{ turn.attempt }}
            </span>
            <span v-if="turn.output && turn.output.adopted" class="turn__tag">adopted after restart</span>
          </span>
          <span class="turn__meta">
            {{ turn.role }}
            <template v-if="turn.participant && turn.participant.model"> · {{ turn.participant.model }}</template>
            <template v-if="turn.participant && turn.participant.effort"> · {{ turn.participant.effort }}</template>
          </span>
        </span>

        <span class="turn__took" :title="turn.timing && turn.timing.unknownReason
          ? turn.timing.unknownReason
          : 'time from the turn being asked to the answer arriving'">{{ took(turn) }}<template v-if="usageTokens(turn.usage) != null"> · {{ formatMTokens(usageTokens(turn.usage)) }}</template></span>

        <span class="turn__marks">
          <v-chip v-if="turn.verdict" :color="verdictColour(turn)" size="x-small" variant="tonal">
            {{ turn.verdict }}
          </v-chip>
          <v-chip v-if="substantial(turn)" size="x-small" variant="tonal" color="warning">
            {{ substantial(turn) }} blocking
          </v-chip>
          <v-icon
            v-if="turn.revision"
            icon="$folder"
            size="14"
            :class="['turn__rev', turn.appliesToCurrentRevision ? 'turn__rev--current' : 'turn__rev--stale']"
            :title="turn.appliesToCurrentRevision
              ? 'produced the current candidate'
              : 'produced an earlier candidate — superseded'"
          />
        </span>
      </button>
    </section>

    <!--
      An in-flight turn is a question that has not been answered. It is not
      streamed text, and is never presented as though it were.
    -->
    <button v-for="a in active" :key="a.invocationId" type="button" class="pending"
            :class="{ 'pending--selected': selected === `live:${a.invocationId}` }"
            :aria-pressed="selected === `live:${a.invocationId}`"
            @click="$emit('select', `live:${a.invocationId}`)">
      <v-progress-circular indeterminate size="14" width="2" class="pending__spin" />
      <span class="pending__text">
        Seat: {{ a.role }} · Step: <strong>{{ formatStep(a.stepId, a.role) }}</strong>
        <template v-if="a.attempt > 1"> (attempt {{ a.attempt }})</template>
      </span>
      <!-- What it was last seen doing: a sign of life, not a measure of progress. -->
      <span class="pending__note">
        awaiting a reply<template v-if="a.activity && a.activity.lastAt"> · {{ activityLabel(a.activity) }} {{ since(a.activity.lastAt) }} ago</template>
      </span>
    </button>

    <p v-if="!timeline.length && !active.length" class="timeline__empty">No turns yet.</p>
  </div>
</template>

<style scoped>
.timeline { display: flex; flex-direction: column; gap: 2px; }
.group { margin-bottom: 6px; }

.group__head { display: flex; align-items: center; gap: 10px; padding: 10px 4px 6px; }

.group__label {
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  opacity: 0.5;
  white-space: nowrap;
}

.group__rule { flex: 1; height: 1px; background: rgb(var(--v-theme-on-surface)); opacity: 0.08; }

.turn {
  display: grid;
  grid-template-columns: 2rem 1rem minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  font: inherit;
  color: inherit;
}

.turn:hover { background: rgb(var(--v-theme-surface-variant)); }
.turn--selected { background: rgb(var(--v-theme-surface-variant)); border-color: rgb(var(--v-theme-primary)); }

/* A restatement sits under the turn it restates, without hiding it. */
.turn--repair { margin-left: 26px; width: calc(100% - 26px); }
.turn--invalid .turn__title { opacity: 0.65; }

.turn__number {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  opacity: 0.45;
  flex: none;
}

.turn__icon { opacity: 0.5; flex: none; }
.turn__body { grid-column: 3 / -1; min-width: 0; }
.turn__title { display: block; font-size: 0.875rem; font-weight: 550; line-height: 1.3; }
.turn__meta { display: block; font-size: 0.75rem; opacity: 0.55; }

.turn__tag { display: inline-block; margin-left: 6px; font-size: 0.6875rem; font-weight: 500; opacity: 0.6; }
.turn__tag--repair { color: rgb(var(--v-theme-warning)); opacity: 0.9; }

.turn__took {
  grid-column: 3;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  opacity: 0.5;
}

.turn__marks { grid-column: 4; display: flex; align-items: center; gap: 4px; flex: none; }
.turn__rev--current { color: rgb(var(--v-theme-success)); }
.turn__rev--stale { opacity: 0.3; }

.pending {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 10px;
  margin-top: 4px;
  border-radius: 8px;
  border: 1px dashed color-mix(in srgb, rgb(var(--v-theme-on-surface)) 18%, transparent);
}

.pending { width: 100%; font: inherit; color: inherit; text-align: left; cursor: pointer; border: 1px solid transparent; }
.pending:hover { border-color: rgba(var(--v-theme-on-surface), 0.15); }
.pending--selected { border-color: rgb(var(--v-theme-primary)); }
.pending__spin { opacity: 0.6; }
.pending__text { font-size: 0.875rem; }
.pending__note { margin-left: auto; font-size: 0.75rem; opacity: 0.5; }
.timeline__empty { padding: 20px 4px; font-size: 0.875rem; opacity: 0.55; }
</style>

<style scoped>
@media (max-width: 600px) {
  .turn__title, .turn__meta { overflow-wrap: anywhere; }
}
</style>
