<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'

import { api } from '@/api'
import { connection, socket } from '@/socket'
import { formatDuration } from '@/format'

/*
 * Every agent currently invoked, anywhere.
 *
 * Two things this deliberately does NOT do:
 *
 *  - It does not hide a live run that has no turn in flight. A playbook between
 *    turns is still working; dropping it would make the list flicker empty every
 *    few seconds and read as "nothing is happening".
 *  - It does not present a run as busy just because its state says `running`. A
 *    run whose owner is gone will never move again, and a spinner next to it
 *    would be a lie. Ownership comes from the server and is shown.
 */

const runs = ref([])
const loading = ref(true)
const error = ref('')
const now = ref(Date.now())

let ticker = null
let poller = null
let pending = null

async function load () {
  try {
    runs.value = await api.listAgents()
    error.value = ''
  } catch (err) {
    // Keep the last known list: a failed poll is not evidence that everything
    // stopped, and blanking it would say exactly that.
    error.value = err.message
  } finally {
    loading.value = false
  }
}

/* Events cover runs this server drives. A run driven by another process sends
   nothing here, so a slow poll covers those rather than leaving them frozen. */
function onRunEvent (payload) {
  // A live output chunk changes nothing listed here; the activity it carries is
  // picked up by the next state event or the slow poll.
  if (payload?.type === 'live') return
  clearTimeout(pending)
  pending = setTimeout(load, 150)
}

onMounted(() => {
  load()
  ticker = setInterval(() => { now.value = Date.now() }, 1000)
  poller = setInterval(load, 10_000)
  socket.on('run:event', onRunEvent)
  socket.on('connect', load)
})

onUnmounted(() => {
  clearInterval(ticker)
  clearInterval(poller)
  clearTimeout(pending)
  socket.off('run:event', onRunEvent)
  socket.off('connect', load)
})

const agentCount = computed(() => runs.value.reduce((n, r) => n + r.agents.length, 0))
const stale = computed(() => connection.status !== 'online' && runs.value.length > 0)

const since = (iso) => {
  if (!iso) return '—'
  now.value // re-evaluate each tick
  return formatDuration(Math.max(0, Math.round((now.value - Date.parse(iso)) / 1000)))
}

const STATUS_COLOUR = {
  preflighting: 'primary', pending: undefined, running: 'primary', stopping: 'warning'
}

/* What the server says about who is driving a run, in words rather than a flag. */
const OWNERSHIP = {
  'this-process': null,
  'another-process': 'driven by another devpanel process',
  'another-run': 'the issue lock is held for a different run',
  unowned: 'nothing is driving this run — it needs recovery'
}

const ownershipNote = (run) => OWNERSHIP[run.ownership] ?? null
const orphaned = (run) => run.ownership === 'unowned'

const label = (step) => (step ?? '').replace(/-/g, ' ')
/* "thinking" is an activity indication, not progress: it says the runtime is
   working, nothing about how near the answer is. */
const activityLabel = (a) => (a.lastKind === 'tool-use' && a.lastDetail ? `using ${a.lastDetail}` : a.lastKind === 'system' && /thinking/.test(a.lastDetail ?? '') ? 'thinking' : (a.lastKind ?? 'active').replace(/-/g, ' '))
const short = (id) => (id ? `${id.slice(0, 8)}…` : '—')

defineExpose({ load })
</script>

<template>
  <div class="agents">
    <v-alert v-if="stale" type="warning" variant="tonal" density="compact" class="agents__notice">
      Connection lost — this list is the last state read, and refreshes when the connection returns.
    </v-alert>

    <v-alert v-else-if="error" type="error" variant="tonal" density="compact" class="agents__notice">
      {{ error }}
    </v-alert>

    <div v-if="loading && !runs.length" class="agents__muted">Looking…</div>

    <div v-else-if="!runs.length" class="empty">
      <div class="empty__mark"><v-icon icon="$chip" size="24" /></div>
      <h3 class="empty__title">No agents are running</h3>
      <p class="empty__body">
        When a playbook is started against an issue, every turn it invokes appears
        here while it is in flight.
      </p>
    </div>

    <article v-for="run in runs" :key="`${run.project}/${run.issueId}/${run.runId}`" class="run">
      <header class="run__head">
        <RouterLink
          class="run__issue"
          :to="{ path: `/projects/${run.project}/${run.issueId}`, query: { run: run.runId } }"
        >{{ run.issueName }}</RouterLink>
        <v-chip size="x-small" variant="tonal" :color="STATUS_COLOUR[run.status]">{{ run.status }}</v-chip>
        <span class="run__meta">{{ run.project.replace(/-project$/, '') }}</span>
        <span class="run__meta">{{ run.playbook.id }}</span>
        <span v-if="run.phase && run.phase.id" class="run__meta">
          {{ run.phase.id }}<template v-if="run.phase.round > 0"> · round {{ run.phase.round + 1 }}</template>
        </span>
        <span class="run__meta run__meta--right">running {{ since(run.startedAt) }}</span>
      </header>

      <p v-if="ownershipNote(run)" class="run__owner" :class="{ 'run__owner--bad': orphaned(run) }">
        <v-icon :icon="orphaned(run) ? '$alertCircle' : '$lan'" size="13" />
        {{ ownershipNote(run) }}<template v-if="run.owner"> (pid {{ run.owner.pid }} on {{ run.owner.host }})</template>
      </p>

      <div v-for="agent in run.agents" :key="agent.invocationId" class="agent">
        <v-progress-circular v-if="!orphaned(run)" indeterminate size="13" width="2" class="agent__spin" />
        <v-icon v-else icon="$alertCircle" size="14" class="agent__spin" />

        <span class="agent__role">{{ agent.role }}</span>

        <span class="agent__body">
          <span class="agent__line">
            {{ agent.model ?? 'unknown model' }}
            <span v-if="agent.wireModel" class="agent__dim">{{ agent.wireModel }}</span>
            <span v-if="agent.harness" class="agent__dim">via {{ agent.harness }}</span>
            <span v-if="agent.profile && agent.profile !== 'default'" class="agent__dim">profile {{ agent.profile }}</span>
            <span v-if="agent.effort" class="agent__dim">{{ agent.effort }}</span>
          </span>
          <span class="agent__line agent__line--sub">
            {{ label(agent.stepId) || 'a turn' }}
            <template v-if="agent.attempt > 1"> · attempt {{ agent.attempt }}</template>
            <template v-if="agent.round > 0"> · round {{ agent.round + 1 }}</template>
            <span class="agent__dim">session {{ short(agent.session) }}</span>
            <span class="agent__dim">invocation {{ short(agent.invocationId) }}</span>
          </span>
          <!-- What the runtime was last seen doing. Liveness evidence only: a
               tool call a moment ago proves the process is alive, not that the
               answer is near, and the label says so. -->
          <span v-if="agent.activity && agent.activity.lastAt" class="agent__line agent__line--sub">
            last seen {{ activityLabel(agent.activity) }} {{ since(agent.activity.lastAt) }} ago
            <span class="agent__dim">pid {{ agent.activity.pid ?? '—' }}</span>
            <span class="agent__dim">{{ agent.activity.events }} events</span>
            <span class="agent__dim">liveness, not progress</span>
          </span>
        </span>

        <!-- How long the question has been out. A turn that has been waiting far
             longer than the others is the one worth looking at. -->
        <span class="agent__waiting">{{ since(agent.startedAt) }}</span>
      </div>

      <p v-if="!run.agents.length" class="agent agent--idle">
        <v-icon icon="$clock" size="13" class="agent__spin" />
        <span v-if="run.status === 'preflighting'">
          checking runtimes before the first turn — no agent has been invoked yet
        </span>
        <span v-else-if="run.status === 'stopping'">stopping — waiting for the runtime to confirm termination</span>
        <span v-else>between turns — no agent is invoked right now</span>
      </p>
    </article>
  </div>
</template>

<style scoped>
.agents { padding: 6px 0 10px; }
.agents__notice { margin: 10px 16px; }
.agents__muted { padding: 20px; font-size: 0.875rem; opacity: 0.6; }

.run { padding: 12px 20px 14px; border-bottom: 1px solid color-mix(in srgb, rgb(var(--v-theme-on-surface)) 8%, transparent); }
.run:last-child { border-bottom: none; }

.run__head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.run__issue { font-size: 0.875rem; font-weight: 600; color: inherit; text-decoration: none; }
.run__issue:hover { text-decoration: underline; }
.run__meta { font-size: 0.75rem; opacity: 0.55; }
.run__meta--right { margin-left: auto; font-variant-numeric: tabular-nums; }

.run__owner { display: flex; align-items: center; gap: 5px; margin-top: 5px; font-size: 0.75rem; opacity: 0.65; }
.run__owner--bad { color: rgb(var(--v-theme-warning)); opacity: 1; }

.agent { display: flex; align-items: flex-start; gap: 9px; padding: 7px 0 0; font-size: 0.8125rem; }
.agent--idle { align-items: center; gap: 6px; opacity: 0.55; font-size: 0.75rem; }
.agent__spin { flex: none; margin-top: 2px; opacity: 0.7; }
.agent__role { flex: none; min-width: 5.25rem; font-weight: 550; }
.agent__body { flex: 1; min-width: 0; }
.agent__line { display: block; overflow-wrap: anywhere; }
.agent__line--sub { font-size: 0.75rem; opacity: 0.6; margin-top: 1px; }

.agent__dim {
  margin-left: 6px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.6875rem;
  opacity: 0.75;
}

.agent__waiting { flex: none; font-size: 0.75rem; font-variant-numeric: tabular-nums; opacity: 0.6; }

.empty { padding: 40px 24px 46px; text-align: center; max-width: 26rem; margin: 0 auto; }

.empty__mark {
  display: grid; place-items: center; width: 46px; height: 46px; margin: 0 auto 14px;
  border-radius: 13px; background: rgb(var(--v-theme-surface-variant)); color: rgb(var(--v-theme-on-surface-variant));
}

.empty__title { font-size: 0.9375rem; font-weight: 600; margin-bottom: 7px; }
.empty__body { font-size: 0.8125rem; line-height: 1.6; opacity: 0.62; }
</style>
