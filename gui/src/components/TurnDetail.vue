<script setup>
import { computed, ref, watch } from 'vue'

import { api } from '@/api'
import MarkdownText from './MarkdownText.vue'
import RunTerminal from './RunTerminal.vue'
import { formatHms, formatMTokens, formatMillis, formatStep, usageTokens } from '@/format'

/*
 * One turn, in full: what was asked, what came back, and what the engine made of it.
 *
 * Markdown uses a restricted set of Vue nodes. Embedded HTML remains text,
 * and raw mode preserves the original response and prompt for inspection.
 */

const props = defineProps({
  turn: { type: Object, default: null },
  // Fill the height it is given (the tabs scroll inside), instead of growing.
  fill: { type: Boolean, default: false },
  project: { type: String, required: true },
  issueId: { type: String, required: true },
  runId: { type: String, default: null },
  currentRevision: { type: String, default: null }
})

const response = ref('')
const loading = ref(false)
const error = ref('')
// The runtime log first: what the agent did, as it did it.
const tab = ref('log')

watch(() => props.turn?.number, async (number) => {
  response.value = ''
  error.value = ''
  if (!number) return
  loading.value = true
  try {
    response.value = await api.stepResponse(props.project, props.issueId, number)
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}, { immediate: true })

const prompt = computed(() => props.turn?.prompt ?? null)

/** The handoff a coordinator wrote, as distinct from the bytes actually sent. */
const authored = computed(() =>
  prompt.value?.source?.kind === 'authored' ? prompt.value.source : null)

const severityColour = (f) =>
  f.severity === 'critical' ? 'error' : f.severity === 'major' ? 'warning' : undefined

const short = (fingerprint) => (fingerprint ? `${fingerprint.slice(0, 19)}…` : '—')

/** Asked → answered. The persistence that follows is not the agent's time. */
const timing = computed(() => props.turn?.timing ?? null)
const clockTime = (iso) => (iso ? iso.slice(11, 23).replace('Z', '') : '—')
</script>

<template>
  <div v-if="turn" class="detail" :class="{ 'detail--fill': fill }">
    <header class="detail__head">
      <div class="detail__heading">
        <h2 class="detail__title">{{ formatStep(turn.stepId, turn.role) }}</h2>
        <p class="detail__sub">
          step {{ turn.number }} · {{ turn.phase }}
          <template v-if="turn.round > 0"> · round {{ turn.round + 1 }}</template>
          <template v-if="turn.attempt > 1"> · attempt {{ turn.attempt }} (restatement)</template>
        </p>
      </div>
      <v-chip v-if="turn.verdict" size="small" variant="tonal"
              :color="turn.verdict === 'approved' ? 'success' : 'warning'">{{ turn.verdict }}</v-chip>
    </header>

    <!-- Who, with what, how long, and the identifiers: one grid, nothing folded. -->
    <dl class="facts">
      <div class="facts__row"><dt>Role</dt><dd>{{ turn.role }}</dd></div>
      <div class="facts__row"><dt>Model</dt>
        <dd>
          {{ turn.participant?.model ?? '—' }}
          <span v-if="turn.participant?.wireModel && turn.participant.wireModel !== turn.participant.model" class="facts__dim">{{ turn.participant.wireModel }}</span>
        </dd>
      </div>
      <div class="facts__row"><dt>Runtime</dt>
        <dd>
          {{ turn.participant?.harness ?? '—' }}
          <span v-if="turn.participant?.profile && turn.participant.profile !== 'default'"
                class="facts__dim">profile {{ turn.participant.profile }}</span>
          · effort {{ turn.participant?.effort ?? 'none' }}
        </dd>
      </div>
      <div class="facts__row"><dt>Took</dt>
        <dd>
          {{ formatHms(timing?.durationMs ?? null) }}
          <span v-if="timing && timing.durationMs !== null" class="facts__dim">
            {{ clockTime(timing.startedAt) }} → {{ clockTime(timing.endedAt) }}
          </span>
          <span v-else-if="timing && timing.unknownReason" class="facts__note">
            {{ timing.unknownReason }}
          </span>
        </dd>
      </div>
      <div class="facts__row"><dt>Tokens</dt><dd>{{ formatMTokens(usageTokens(turn.usage)) }}</dd></div>
      <div class="facts__row" v-if="turn.revision">
        <dt>Revision</dt>
        <dd>
          <code :title="turn.revision">{{ short(turn.revision) }}</code>
          <v-chip size="x-small" variant="tonal" class="ml-2"
                  :color="turn.appliesToCurrentRevision ? 'success' : undefined">
            {{ turn.appliesToCurrentRevision ? 'current candidate' : 'superseded' }}
          </v-chip>
        </dd>
      </div>
      <div class="facts__row facts__row--mono"><dt>Session</dt><dd :title="turn.session ?? ''"><code>{{ turn.session ?? '—' }}</code></dd></div>
      <div class="facts__row facts__row--mono"><dt>Invocation</dt><dd :title="turn.invocationId"><code>{{ turn.invocationId }}</code></dd></div>
    </dl>

    <div v-if="turn.findings && turn.findings.length" class="findings">
      <h3 class="section">Findings</h3>
      <div v-for="f in turn.findings" :key="f.id" class="finding">
        <v-chip size="x-small" variant="tonal" :color="severityColour(f)">{{ f.severity }}</v-chip>
        <v-chip v-if="f.blocking" size="x-small" variant="tonal" color="error">blocking</v-chip>
        <span class="finding__id">{{ f.id }}</span>
        <span class="finding__text">{{ f.description }}</span>
        <code v-if="f.location" class="finding__at">{{ f.location }}</code>
      </div>
    </div>

    <v-alert v-if="turn.output && turn.output.valid === false" type="warning" variant="tonal"
             density="compact" class="mt-3">
      The engine could not read this response as a {{ turn.output.contract }}:
      {{ turn.output.error }} — the same participant was asked to restate it.
    </v-alert>

    <v-tabs v-model="tab" density="compact" class="tabs">
      <v-tab value="log">Runtime log</v-tab>
      <v-tab value="prompt">Prompt</v-tab>
      <v-tab value="response">Response</v-tab>
      <v-tab value="structured">Output</v-tab>
    </v-tabs>

    <v-window v-model="tab" class="window">
      <v-window-item value="prompt">
        <p v-if="prompt" class="muted">
          Recorded before the call. Select Raw text to inspect the exact prompt sent to the runtime.
          <template v-if="prompt.source.kind === 'template'">
            Rendered from <code>{{ prompt.source.template }}</code>.
          </template>
          <template v-else>
            Written at runtime by the {{ prompt.source.by || 'coordinator' }}.
          </template>
        </p>
        <ul v-if="prompt && prompt.appended.length" class="appended">
          <li v-for="a in prompt.appended" :key="a.reason">
            <code>{{ a.reason }}</code> appended by the engine
          </li>
        </ul>
        <MarkdownText v-if="prompt" :text="prompt.rendered" structured />
        <p v-else class="muted">No prompt was recorded for this turn.</p>
        <details v-if="authored" class="handoff mt-4">
          <summary>Authored handoff</summary>
          <p class="muted mt-2">What the {{ authored.by || 'coordinator' }} wrote, before the engine added anything.</p>
          <MarkdownText :text="authored.text" structured />
        </details>
      </v-window-item>

      <v-window-item value="response">
        <div v-if="loading" class="muted">Loading…</div>
        <v-alert v-else-if="error" type="error" variant="tonal" density="compact">{{ error }}</v-alert>
        <MarkdownText v-else :key="turn.number" :text="response" structured />
      </v-window-item>

      <v-window-item value="structured">
        <MarkdownText v-if="turn.output && turn.output.value" :key="`out-${turn.number}`" :text="JSON.stringify(turn.output.value, null, 2)" structured />
        <p v-else class="muted">No structured output was recorded for this turn.</p>
      </v-window-item>

      <v-window-item value="log">
        <div v-if="runId && tab === 'log'" class="log-terminal">
          <RunTerminal :key="turn.invocationId"
                       :project="project" :issue-id="issueId" :run-id="runId"
                       :invocation-id="turn.invocationId" :role="turn.role" :step-id="turn.stepId"
                       :model="turn.participant?.model ?? null" />
        </div>
        <p v-else-if="!runId" class="muted">No run context.</p>
      </v-window-item>
    </v-window>
  </div>

  <div v-else class="detail detail--empty">
    <p class="muted">Select a turn to see what was asked and what came back.</p>
  </div>
</template>

<style scoped>
.detail { padding: 14px 18px 16px; display: flex; flex-direction: column; min-height: 100%; }
/* Given a height (the issue page's step column), the tabs take what is left,
   and the runtime log fills it. */
.detail--fill { height: 100%; min-height: 0; }
.detail--fill .window { flex: 1; min-height: 0; overflow-y: auto; }
.detail--fill .window :deep(.v-window__container), .detail--fill .window :deep(.v-window-item) { height: 100%; }
.detail--fill .log-terminal { height: 100%; min-height: 320px; }
.detail--empty { display: grid; place-items: center; min-height: 200px; }

.detail__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.detail__title { font-size: 1rem; font-weight: 650; text-transform: capitalize; }
.detail__heading { display: flex; align-items: baseline; flex-wrap: wrap; gap: 2px 12px; }
.detail__sub { font-size: 0.75rem; opacity: 0.6; }

.facts { margin: 8px 0 2px; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 250px), 1fr)); gap: 2px 20px; }
.facts__row { display: flex; gap: 10px; font-size: 0.8125rem; min-width: 0; }
.facts__row dd { min-width: 0; overflow-wrap: anywhere; }
.facts__row--mono dd { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.facts__row--mono code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.6875rem; }
.facts__row dt { flex: none; min-width: 4.75rem; opacity: 0.55; }
.facts__row dd { margin: 0; }
.facts__dim { opacity: 0.5; margin-left: 6px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.75rem; }
.facts--mono dd { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.75rem; }
.facts__note { display: block; font-size: 0.75rem; opacity: 0.55; margin-top: 2px; }

.wrap { overflow-wrap: anywhere; }

.section { font-size: 0.6875rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; opacity: 0.55; margin: 14px 0 6px; }

.finding { display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; font-size: 0.8125rem; padding: 4px 0; }
.finding__id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.75rem; opacity: 0.6; }
.finding__text { flex: 1; min-width: 12rem; }
.finding__at { font-size: 0.75rem; opacity: 0.5; }

.handoff summary { cursor: pointer; font-size: 0.8125rem; font-weight: 550; }
.tabs { margin-top: 10px; flex: none; }
.window { margin-top: 10px; }
.log-terminal { height: 70vh; min-height: 320px; }

.body {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.8125rem;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: rgb(var(--v-theme-surface-variant));
  color: rgb(var(--v-theme-on-surface-variant));
  padding: 14px 16px;
  border-radius: 8px;
  max-height: 60vh;
  overflow-y: auto;
  margin: 0;
}

.appended { margin: 6px 0 8px 1rem; font-size: 0.75rem; opacity: 0.6; }
.appended code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.muted { font-size: 0.8125rem; opacity: 0.6; margin-bottom: 8px; }
</style>
