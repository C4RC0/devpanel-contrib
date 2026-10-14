<script setup>
import { formatHms, formatMTokens, usageTokens } from '@/format'
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { api } from '@/api'
import { actorName, proxyUser, rememberedActor } from '@/identity'

/*
 * Model availability: every roster model and the cooldown this host has
 * recorded for it. A model shown as exhausted is refused by every start that
 * names it until the recorded instant passes or an operator clears it here.
 * The page polls: exhaustion is written by running engines, not by this view.
 */
const report = ref(null)
const error = ref('')
const refreshing = ref(false)
const measuring = computed(() => refreshing.value || report.value?.performance?.refresh?.status === 'running')
let lastRead = 0
let requestId = 0
const busy = ref('')
const now = ref(Date.now())
const actor = ref(rememberedActor())
const hold = ref({ model: null, until: '', reason: '' })

async function load () {
  const id = ++requestId
  lastRead = Date.now()
  try {
    const data = await api.availability()
    if (id !== requestId) return
    report.value = data
    error.value = ''
  } catch (err) {
    error.value = err.message
  }
}

async function refresh () {
  if (measuring.value) return
  refreshing.value = true
  const id = ++requestId
  try {
    const data = await api.refreshAvailability()
    if (id === requestId) report.value = data
    error.value = ''
  } catch (err) { error.value = err.message }
  finally { refreshing.value = false }
}
const duration = ms => typeof ms === 'number' ? `${(ms / 1000).toFixed(2)} s` : '—'
const tokenRate = rate => Number.isFinite(rate) && rate >= 0 ? `${rate.toFixed(2)} tok/s` : '—'
const measuredTime = iso => iso ? new Date(iso).toLocaleString() : 'Never measured'

const remaining = (iso) => {
  const ms = Date.parse(iso) - now.value
  if (!(ms > 0)) return 'expired'
  const m = Math.round(ms / 60000)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.round(h / 24)} d`
}

const rows = computed(() => (report.value?.models ?? []).map((m) => ({
  ...m,
  remaining: m.record ? remaining(m.record.exhaustedUntil) : null
})))

async function clear (model) {
  busy.value = model.id
  try {
    await api.clearAvailability(model.id)
    await load()
  } catch (err) {
    error.value = err.message
  } finally {
    busy.value = ''
  }
}

function openHold (model) {
  const soon = new Date(Date.now() + 60 * 60000)
  soon.setSeconds(0, 0)
  hold.value = { model, until: soon.toISOString().slice(0, 16), reason: '' }
}

async function submitHold () {
  if (!hold.value.model) return
  if (!actorName(actor.value)) { error.value = 'Your name is required to record a hold.'; return }
  busy.value = hold.value.model.id
  try {
    // The field is local time; the server wants an instant.
    await api.holdAvailability(hold.value.model.id, new Date(hold.value.until).toISOString(), hold.value.reason, actorName(actor.value))
    hold.value = { model: null, until: '', reason: '' }
    await load()
  } catch (err) {
    error.value = err.message
  } finally {
    busy.value = ''
  }
}

/* The active decision provider (TypeSafe Jev by default, or the OpenAI Decisions API
   as decisions/active.yaml selects): not a roster model and never a seat, but
   it is held, cleared and tested from here like one. A hold makes every caller
   fall back to what it did before decisions existed. */
const providers = computed(() => (report.value?.decisionProviders ?? []).map((p) => ({
  ...p,
  remaining: p.record ? remaining(p.record.exhaustedUntil) : null
})))
const probing = ref(false)
const probeResult = ref(null)
async function probe () {
  probing.value = true
  probeResult.value = null
  try {
    const result = await api.probeDecisions()
    probeResult.value = result.record
    await load()
  } catch (err) { error.value = err.message } finally { probing.value = false }
}

let poll = null
let tick = null
onMounted(async () => {
  await load()
  poll = setInterval(() => { if (!refreshing.value && (measuring.value || Date.now() - lastRead >= 30000)) load() }, 2000)
  tick = setInterval(() => { now.value = Date.now() }, 15000)
})
onUnmounted(() => { clearInterval(poll); clearInterval(tick) })
</script>

<template>
  <v-container fluid class="models">
    <header class="models__head">
      <div>
        <h1 class="models__title">Model availability</h1>
        <p class="models__subtitle">
          Model availability, measured response times and token rates.
          <span v-if="report"> {{ report.exhausted }} exhausted · checked {{ report.checkedAt }}</span>
        </p>
      </div>
      <v-btn icon="$refresh" variant="text" density="comfortable" aria-label="Refresh and measure models" title="Run a 200-word text-generation measurement for available verified models" :loading="measuring" :disabled="measuring" @click="refresh" />
    </header>

    <v-alert v-if="error" type="error" variant="tonal" density="compact" class="mb-4">{{ error }}</v-alert>
    <v-alert v-if="report?.errors?.length" type="warning" variant="tonal" density="compact" class="mb-4">
      The configuration has {{ report.errors.length }} problem{{ report.errors.length === 1 ? '' : 's' }}; models it could not load are not listed.
    </v-alert>

    <v-alert v-if="measuring" type="info" variant="tonal" density="compact" class="mb-4" role="status">
      Measuring {{ report?.performance?.refresh?.currentModel ?? 'models' }}…
      {{ report?.performance?.refresh?.completed ?? 0 }} / {{ report?.performance?.refresh?.total ?? 0 }} complete.
    </v-alert>
    <p v-else-if="report?.performance?.refresh" class="models__note" role="status">
      Last refresh: {{ report.performance.refresh.status }} · {{ report.performance.refresh.completed }} measured ·
      {{ report.performance.refresh.failed }} unsuccessful · {{ report.performance.refresh.skipped }} skipped.
      {{ report.performance.refresh.error ?? '' }}
    </p>
    <p class="models__note">
      Refresh makes one roughly 200-word text-generation call per available, verified model and uses its normal quota or API billing.
      Startup: invocation to CLI ready. Response: CLI ready to first visible answer. Total: invocation to completion.
      Tokens/s: reported output tokens divided by time from CLI ready to completion. Includes thinking and cleanup, excludes startup; not pure token-generation speed.
      Each is a single sample; missing events show —. Unverified models and models on hold are skipped.
    </p>

    <p class="models__note">
      A run that names an exhausted model is refused before anything is reserved. Records come from
      runs that hit a quota (the provider's reset instant when it gave one, otherwise an assumed hold)
      or from an operator's hold below. Clearing a record does not make a quota exist; it only lets the
      next start try.
    </p>

    <v-table v-if="report" density="comfortable" class="models__table">
      <thead>
        <tr>
          <th>Model</th>
          <th>Harness</th>
          <th>Verified</th>
          <th>State</th>
          <th title="Invocation start to CLI ready">Startup</th>
          <th title="CLI ready to first visible answer; not necessarily first token">Response</th>
          <th title="Invocation start to completion">Total</th>
          <th title="Reported output tokens per second from CLI ready to completion, including thinking and cleanup">Tokens/s</th>
          <th title="Actual response length from the roughly 200-word prompt">Response length</th>
          <th>Measurement</th>
          <th>Until</th>
          <th>Reason</th>
          <th class="models__actions-head">Actions</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="m in rows" :key="m.id" :class="{ 'models__row--exhausted': m.state === 'exhausted' }">
          <td>
            <div class="models__id">{{ m.id }}</div>
            <div v-if="m.wire && m.wire !== m.id" class="models__wire">{{ m.wire }}<span v-if="m.profile && m.profile !== 'default'"> · {{ m.profile }}</span></div>
          </td>
          <td>{{ m.harness ?? '—' }}</td>
          <td>
            <v-chip size="x-small" :color="m.verification === 'verified' ? 'success' : m.verification === 'not-in-roster' ? 'warning' : undefined" variant="tonal">{{ m.verification }}</v-chip>
          </td>
          <td>
            <v-chip size="small" :color="m.state === 'exhausted' ? 'error' : 'success'" variant="tonal">
              {{ m.state }}<span v-if="m.record?.active && m.record.assumed"> (assumed)</span>
            </v-chip>
          </td>
          <td class="models__timing">{{ duration(m.performance?.startupMs) }}</td>
          <td class="models__timing">{{ duration(m.performance?.responseMs) }}</td>
          <td class="models__timing">{{ duration(m.performance?.totalMs) }}</td>
          <td class="models__timing">{{ tokenRate(m.performance?.tokensPerSecond) }}</td>
          <td class="models__timing">
            <template v-if="Number.isFinite(m.performance?.responseWords)">{{ m.performance.responseWords }} words</template>
            <span v-else>—</span>
            <div v-if="Number.isFinite(m.performance?.outputTokens)" class="models__muted">{{ m.performance.outputTokens }} output tokens</div>
          </td>
          <td class="models__measurement">
            <template v-if="m.performance">
              <v-chip size="x-small" variant="tonal" :color="m.performance.stale ? 'warning' : m.performance.status === 'ok' ? 'success' : 'warning'">
                {{ m.performance.stale ? 'Stale configuration' : m.performance.status }}
              </v-chip>
              <div class="models__muted">{{ measuredTime(m.performance.measuredAt) }}</div>
              <div v-if="m.performance.error" class="models__muted">{{ m.performance.error }}</div>
            </template>
            <span v-else class="models__muted">Not measured</span>
          </td>
          <td>
            <template v-if="m.record">
              <div>{{ m.record.exhaustedUntil }}</div>
              <div class="models__muted">{{ m.record.active ? `${m.remaining} left` : `expired · observed ${m.record.observedAt}` }}</div>
            </template>
            <span v-else class="models__muted">—</span>
          </td>
          <td class="models__reason">
            <template v-if="m.record">
              <div>{{ m.record.reason }}</div>
              <div class="models__muted">
                <span v-if="m.record.runId">run {{ m.record.runId }}<span v-if="m.record.role"> · {{ m.record.role }}</span></span>
                <span v-else-if="m.record.actor">hold by {{ m.record.actor }}</span>
              </div>
            </template>
            <span v-else class="models__muted">no record</span>
          </td>
          <td class="models__actions">
            <v-btn v-if="m.record" size="x-small" variant="tonal" :loading="busy === m.id" @click="clear(m)">Clear</v-btn>
            <v-btn v-if="m.state === 'available' && m.verification !== 'not-in-roster'" size="x-small" variant="text" :disabled="busy === m.id" @click="openHold(m)">Hold…</v-btn>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td colspan="13" class="models__muted">No models in the roster.</td>
        </tr>
      </tbody>
    </v-table>

    <h2 class="models__section">Decision provider</h2>
    <p class="models__note">
      The advisory classifier behind the Triage pre-gate, the supervisor's wake filter and the second opinion on
      unrecognised run failures. It is never a seat and never decides approvals or closure. While it is held,
      unconfigured or failing, every caller does what it did without it. A rejected key holds it automatically;
      a rate limit holds it for the provider's retry-after. Test makes one short real request (a fraction of a cent).
    </p>
    <v-table v-if="report" density="comfortable" class="models__table">
      <thead>
        <tr>
          <th>Provider</th>
          <th>Model</th>
          <th>Key</th>
          <th>State</th>
          <th>Threshold</th>
          <th>Last call</th>
          <th>Calls today · month</th>
          <th>Until</th>
          <th>Reason</th>
          <th class="models__actions-head">Actions</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="p in providers" :key="p.id" :class="{ 'models__row--exhausted': p.state === 'exhausted' }">
          <td>
            <div class="models__id">{{ p.title ?? p.id }}</div>
            <div class="models__wire">{{ p.endpoint }}</div>
          </td>
          <td>
            <div>{{ p.model ?? '—' }}</div>
            <div v-if="p.lastOutcome?.model" class="models__muted">last answered as {{ p.lastOutcome.model }}</div>
          </td>
          <td>
            <v-chip size="x-small" variant="tonal" :color="p.credential?.ok ? 'success' : 'error'">{{ p.credential?.ok ? 'readable' : 'unusable' }}</v-chip>
            <div class="models__muted">{{ p.credential?.ref }}</div>
            <div v-if="p.credential && !p.credential.ok" class="models__muted">{{ p.credential.error }}</div>
          </td>
          <td>
            <v-chip size="small" variant="tonal" :color="p.state === 'available' ? 'success' : p.state === 'exhausted' ? 'error' : 'warning'">
              {{ p.state === 'exhausted' ? 'held' : p.state }}<span v-if="p.record?.active && p.record.assumed"> (assumed)</span>
            </v-chip>
            <div v-if="p.error" class="models__muted">{{ p.error }}</div>
          </td>
          <td>{{ p.threshold ?? '—' }}</td>
          <td class="models__measurement">
            <template v-if="p.lastOutcome">
              <v-chip size="x-small" variant="tonal" :color="p.lastOutcome.status === 'answered' ? 'success' : 'warning'">{{ p.lastOutcome.status === 'answered' ? 'answered' : p.lastOutcome.failure?.class ?? p.lastOutcome.status }}</v-chip>
              <div class="models__muted">{{ measuredTime(p.lastOutcome.at) }} · {{ p.lastOutcome.purpose }}</div>
              <div class="models__muted">{{ formatHms(p.lastOutcome.latencyMs) }} · {{ formatMTokens(p.lastOutcome.tokens) }}</div>
              <div v-if="p.lastOutcome.failure" class="models__muted">{{ p.lastOutcome.failure.message }}</div>
            </template>
            <span v-else class="models__muted">None since the service started</span>
          </td>
          <td class="models__timing">{{ p.usage ? `${p.usage.today} · ${p.usage.month}` : '—' }}</td>
          <td>
            <template v-if="p.record">
              <div>{{ p.record.exhaustedUntil }}</div>
              <div class="models__muted">{{ p.record.active ? `${p.remaining} left` : `expired · observed ${p.record.observedAt}` }}</div>
            </template>
            <span v-else class="models__muted">—</span>
          </td>
          <td class="models__reason">
            <template v-if="p.record">
              <div>{{ p.record.reason }}</div>
              <div v-if="p.record.actor" class="models__muted">hold by {{ p.record.actor }}</div>
            </template>
            <span v-else class="models__muted">no record</span>
          </td>
          <td class="models__actions">
            <v-btn v-if="p.configured && p.state !== 'exhausted'" size="x-small" variant="tonal" :loading="probing" @click="probe">Test</v-btn>
            <v-btn v-if="p.record" size="x-small" variant="tonal" :loading="busy === p.id" @click="clear(p)">Clear</v-btn>
            <v-btn v-if="p.configured && p.state !== 'exhausted'" size="x-small" variant="text" :disabled="busy === p.id" @click="openHold(p)">Hold…</v-btn>
          </td>
        </tr>
        <tr v-if="!providers.length">
          <td colspan="10" class="models__muted">No decision provider is configured (decisions/&lt;id&gt;.yaml, selected by decisions/active.yaml; jev by default).</td>
        </tr>
      </tbody>
    </v-table>
    <p v-if="probeResult" class="models__note mt-2" role="status">
      Test: <strong>{{ probeResult.status ?? probeResult.skipped }}</strong>
      <template v-if="probeResult.status === 'answered'"> by {{ probeResult.model }} in {{ formatHms(probeResult.latencyMs) }}, {{ formatMTokens(usageTokens(probeResult.usage)) }}</template>
      <template v-else-if="probeResult.failure"> — {{ probeResult.failure.class }}: {{ probeResult.failure.message }}</template>
      <template v-else-if="probeResult.skipped === 'held'"> — on hold until {{ probeResult.hold?.exhaustedUntil }}</template>
    </p>

    <v-dialog :model-value="Boolean(hold.model)" max-width="520" @update:model-value="(v) => { if (!v) hold.model = null }">
      <v-card v-if="hold.model">
        <v-card-title>Hold {{ hold.model.id }}</v-card-title>
        <v-card-text>
          <p v-if="hold.model.id.startsWith('decision:')" class="models__note">No decision is asked until the instant below; every caller does what it did without the provider.</p>
          <p v-else class="models__note">Starts naming this model are refused until the instant below. Use it for a quota the provider announced that no run has hit yet.</p>
          <v-text-field v-model="hold.until" type="datetime-local" label="Until (local time)" density="compact" variant="outlined" />
          <v-text-field v-model="hold.reason" label="Reason" density="compact" variant="outlined" />
          <v-text-field v-if="!proxyUser" v-model="actor" label="Your name (recorded with the hold)" density="compact" variant="outlined" />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="hold.model = null">Cancel</v-btn>
          <v-btn color="primary" variant="tonal" :loading="busy === hold.model.id" @click="submitHold">Record hold</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<style scoped>
.models { max-width: 1400px; padding: 28px 24px 40px; }
.models__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
.models__title { font-size: 1.5rem; font-weight: 650; letter-spacing: -0.02em; line-height: 1.2; }
.models__subtitle { margin-top: 5px; font-size: 0.875rem; color: rgb(var(--v-theme-on-surface)); opacity: 0.62; }
.models__section { font-size: 1.125rem; font-weight: 600; margin: 28px 0 8px; }
.models__note { font-size: 0.875rem; opacity: 0.8; margin-bottom: 16px; max-width: 80ch; }
.models__timing { white-space: nowrap; font-variant-numeric: tabular-nums; }
.models__measurement { min-width: 170px; max-width: 28ch; }
.models__table { overflow-x: auto; }
.models__id { font-weight: 600; }
.models__wire, .models__muted { font-size: 0.8rem; opacity: 0.65; }
.models__reason { max-width: 36ch; word-break: break-word; }
.models__actions { white-space: nowrap; }
.models__actions-head { text-align: right; }
.models__row--exhausted td { background: rgba(var(--v-theme-error), 0.06); }
@media (max-width: 700px) {
  .models { padding: 16px; }
  .models__head { flex-direction: column; }
}
</style>
