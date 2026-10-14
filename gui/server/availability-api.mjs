import { loadConfig } from './config/load.mjs'
import { performanceForModel } from './model-performance.mjs'

/*
 * The model availability page: every roster model, with the cooldown the host
 * has recorded for it, if any. Configuration is read offline (load only, no
 * probes); the store is the supervisor's, so what the page shows is exactly
 * what a start would be judged against.
 */
export async function availabilityReport ({ store, performance = null, configRoot = process.env.DEVPANEL_CONFIG_ROOT, decisionProviders = async () => [] } = {}) {
  const timings = performance?.snapshot() ?? null
  const cfg = await loadConfig({ root: configRoot })
  // Decision providers share the store under `decision:<id>` and have their own section.
  const records = new Map((await store.all()).filter((r) => !r.modelId.startsWith('decision:')).map((r) => [r.modelId, r]))
  const models = [...cfg.roster.values()].map((m) => {
    const record = records.get(m.id) ?? null
    records.delete(m.id)
    return {
      id: m.id,
      title: m.title ?? m.id,
      harness: m.harness,
      wire: m.model ?? null,
      profile: m.profile ?? 'default',
      verification: m.verification?.status ?? 'unverified',
      state: record?.active ? 'exhausted' : 'available',
      record,
      performance: performanceForModel(timings, m)
    }
  })
  // A record for a model no longer in the roster is still shown: it explains
  // why a start named it, and an operator may want to clear it.
  for (const record of records.values()) {
    models.push({ id: record.modelId, title: record.modelId, harness: record.harness ?? null, wire: null, profile: null, verification: 'not-in-roster', state: record.active ? 'exhausted' : 'available', record })
  }
  models.sort((a, b) => (a.state === b.state ? a.id.localeCompare(b.id) : a.state === 'exhausted' ? -1 : 1))
  return { performance: timings ? { refresh: timings.refresh, definitions: timings.definitions, timeoutMs: timings.timeoutMs } : null, file: store.file, checkedAt: new Date().toISOString(), exhausted: models.filter((m) => m.state === 'exhausted').length, models, decisionProviders: await decisionProviders(), errors: cfg.errors }
}
