<script setup>
import { computed, ref, watch } from 'vue'
import { api } from '@/api'

const props = defineProps({ project: { type: String, required: true } })
const infrastructure = ref(null), error = ref(''), output = ref(null), busy = ref(false)
let sequence = 0
watch(() => props.project, async project => {
  const request = ++sequence
  infrastructure.value = null; output.value = null; error.value = ''; busy.value = false
  try {
    const result = await api.infrastructure(project)
    if (request === sequence) infrastructure.value = result
  } catch (e) { if (request === sequence) error.value = e.message }
}, { immediate: true })
const environments = computed(() => infrastructure.value ? [
  { ...infrastructure.value.staging, role: 'Staging' },
  ...infrastructure.value.deployments.map(e => ({ ...e, role: 'Deployment · inspection only' }))
] : [])
async function inspect (environment, resource) {
  const request = sequence
  busy.value = true; error.value = ''
  try {
    const result = await api.inspectEnvironment(props.project, environment, resource)
    if (request === sequence) output.value = result
  } catch (e) { if (request === sequence) error.value = e.message }
  finally { if (request === sequence) busy.value = false }
}
</script>

<template>
  <v-alert v-if="error" type="error" variant="tonal" class="mb-3">{{ error }}</v-alert>
  <details v-if="infrastructure" class="infrastructure">
    <summary>Infrastructure · {{ infrastructure.staging.id }} staging · {{ infrastructure.deployments.length }} deployment environments</summary>
    <p class="orientation">{{ infrastructure.orientation }}</p>
    <article v-for="env in environments" :key="env.id">
      <strong>{{ env.id }}</strong> · {{ env.role }}
      <p><code>{{ env.ssh.hostRef }}</code> · <code>{{ env.projectRoot }}</code></p>
      <p>{{ env.notes }}</p>
      <v-btn v-if="env.statusCommand" size="small" variant="text" :disabled="busy" @click="inspect(env.id, 'status')">Read status</v-btn>
      <v-btn v-for="(file, resource) in env.files" :key="resource" :title="file" size="small" variant="text" :disabled="busy" @click="inspect(env.id, resource)">Read {{ resource }}</v-btn>
    </article>
    <p>Test drive: {{ infrastructure.testDrive.requirement ?? 'required' }} · {{ infrastructure.testDrive.notes }}</p>
    <details><summary>Test-drive commands</summary><pre>{{ JSON.stringify(infrastructure.testDrive, null, 2) }}</pre></details>
    <p>Configure in <code>projects/{{ project }}.yaml</code>. Changes apply to new runs; active runs keep their recorded settings.</p>
    <section v-if="output" aria-label="Environment diagnostics">
      <p>{{ output.environment }} · {{ output.resource }} · {{ output.at }} · {{ output.available ? 'read successfully' : 'unavailable or command failed' }}</p>
      <pre>{{ output.stdout }}{{ output.stderr }}</pre>
    </section>
  </details>
</template>

<style scoped>
.infrastructure { border: 1px solid rgba(var(--v-theme-on-surface), .15); border-radius: 8px; padding: 12px; margin-bottom: 16px; font-size: .8125rem; overflow-wrap: anywhere; }
summary { cursor: pointer; font-weight: 600; }
p { margin: 8px 0; }
.orientation { white-space: pre-wrap; }
article { border-top: 1px solid rgba(var(--v-theme-on-surface), .12); padding: 10px 0; }
pre { white-space: pre-wrap; max-height: 360px; overflow: auto; }
</style>
