import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { CONFIG_ROOT, loadConfig } from './config/load.mjs'
import { writeJson } from './runtime/persistence.mjs'
import { acquire } from './runtime/lock.mjs'
import { classifyFailure } from './runtime/failure.mjs'
import { runlessFence } from '../../harness/fence.mjs'

export const timingDefinitions = {
  startupMs: 'Invocation start to the first CLI readiness event.',
  responseMs: 'CLI readiness to the first visible answer event (not necessarily the first token).',
  totalMs: 'Invocation start to completion, including response generation and cleanup.',
  tokensPerSecond: 'Reported output tokens divided by seconds from CLI readiness to completion, including thinking and cleanup but excluding startup.',
  scope: 'One fresh-session sample requesting about 200 words; not a pure token-generation or task-quality benchmark.'
}
export const modelFingerprint = m => crypto.createHash('sha256').update(JSON.stringify([
  'text-200-words-v1', m.harness, m.model, m.profile ?? 'default', m.account ?? null,
  m.endpointRef ?? null, m.credentialRef ?? null, m.defaultEffort ?? null
])).digest('hex')
export function performanceForModel (snapshot, model) {
  const sample = snapshot?.models?.[model.id]
  if (!sample) return null
  return { ...sample, stale: sample.fingerprint !== modelFingerprint(model) }
}

// Only explicit refresh starts calls. Reads and supervisor context never probe.
export async function createModelPerformanceService ({
  file, availability, configRoot = process.env.DEVPANEL_CONFIG_ROOT ?? CONFIG_ROOT,
  load = () => loadConfig({ root: configRoot }),
  loadAdapter = async harness => import(pathToFileURL(path.join(process.env.DEVPANEL_HARNESS_DIR ?? path.join(configRoot, 'harness'), `${harness}.mjs`)).href),
  timeoutMs = 120000, monotonic = () => performance.now(), now = () => new Date().toISOString()
}) {
  let state = { version: 1, models: {}, refresh: null }
  try {
    state = JSON.parse(await fs.readFile(file, 'utf8'))
    if (state.version !== 1 || !state.models || Array.isArray(state.models)) throw new Error('Invalid model performance data')
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (state.refresh?.status === 'running') state.refresh = { ...state.refresh, status: 'interrupted', currentModel: null, finishedAt: now() }
  let running = null, starting = null, controller = null, closed = false
  const snapshot = () => structuredClone({ ...state, definitions: timingDefinitions, timeoutMs })
  const save = () => writeJson(file, state)

  async function measure (model) {
    const record = { modelId: model.id, fingerprint: modelFingerprint(model), measuredAt: now(), status: 'running',
      startupMs: null, responseMs: null, totalMs: null, costUsd: null, tokens: null, outputTokens: null, responseWords: null, tokensPerSecond: null, error: null }
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-model-timing-'))
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), timeoutMs)
    const signal = AbortSignal.any([controller.signal, deadline.signal])
    let start = null, ready = null, first = null, toolUsed = false
    try {
      const adapter = await loadAdapter(model.harness)
      const cwd = path.join(temp, 'workspace'), scratchDir = path.join(temp, 'scratch')
      await fs.mkdir(cwd); await fs.mkdir(scratchDir)
      start = monotonic()
      const result = await adapter.invoke({
        model: model.model, effort: model.defaultEffort ?? null, profile: model.profile ?? 'default',
        endpointRef: model.endpointRef ?? null, credentialRef: model.credentialRef ?? null, account: model.account ?? null,
        cwd, scratchDir, session: null, supervisorOnly: true, hygiene: true, fence: runlessFence({ cwd, writable: [scratchDir] }), signal,
        prompt: 'Write about 200 words of plain English describing a walk through a quiet park on a sunny morning. Start directly with the description, without a heading or preamble. Do not use tools or inspect files.',
        meta: { invocationId: `model-timing-${crypto.randomUUID()}`, role: 'performance-probe' },
        observe: { onActivity: event => {
          const time = monotonic()
          if (event.kind === 'system' && ready === null) ready = time
          if (event.kind === 'text' && first === null) first = time
          if (event.kind === 'tool-use') { toolUsed = true; deadline.abort() }
        } }
      })
      record.costUsd = typeof result.usage?.costUsd === 'number' ? result.usage.costUsd : null
      record.tokens = typeof result.usage?.tokens === 'number' ? result.usage.tokens : null
      record.outputTokens = Number.isFinite(result.usage?.outputTokens) && result.usage.outputTokens >= 0 ? result.usage.outputTokens : null
      record.responseWords = result.response?.trim().match(/\S+/g)?.length ?? 0
      if (signal.aborted) throw new Error('aborted')
      if (result.outcome && result.outcome !== 'completed') throw new Error('incomplete')
      if (record.responseWords < 100) {
        record.status = 'invalid-response'; record.error = 'The model returned fewer than 100 words; the sample is too short to measure.'
      } else record.status = 'ok'
    } catch (error) {
      const failure = classifyFailure(error)
      record.status = toolUsed ? 'error' : controller.signal.aborted ? 'cancelled' : deadline.signal.aborted ? 'timeout' : 'error'
      record.error = toolUsed ? 'The probe attempted a tool call.' : record.status === 'timeout' ? `No completed answer within ${timeoutMs / 1000} seconds.` : record.status === 'cancelled' ? 'Measurement cancelled.' : `Measurement failed (${failure.class ?? 'runtime-error'}).`
      // Never persist raw stderr or error text: providers may echo credentials.
      if (failure.class === 'quota' && availability.recordExhausted) {
        await availability.recordExhausted({ modelId: model.id, reason: 'Quota reported by the text-generation performance probe.' })
      }
    } finally {
      clearTimeout(timer)
      if (start !== null) record.totalMs = Math.max(0, Math.round(monotonic() - start))
      if (ready !== null) record.startupMs = Math.max(0, Math.round(ready - start))
      if (ready !== null && first !== null && first >= ready) record.responseMs = Math.round(first - ready)
      const generationMs = ready !== null ? record.totalMs - record.startupMs : null
      if (record.status === 'ok' && record.outputTokens !== null && generationMs > 0) {
        record.tokensPerSecond = record.outputTokens * 1000 / generationMs
      }
      await fs.rm(temp, { recursive: true, force: true })
    }
    return record
  }

  async function run (models, lock) {
    try {
      for (const model of models) {
        if (controller.signal.aborted) break
        // A hold may have appeared since the refresh started.
        if (await availability.check(model.id)) { state.refresh.skipped++; continue }
        state.refresh.currentModel = model.id
        await save()
        state.models[model.id] = await measure(model)
        state.refresh.completed++
        if (state.models[model.id].status !== 'ok') state.refresh.failed++
        await save()
      }
      state.refresh.status = controller.signal.aborted ? 'cancelled' : 'completed'
    } catch {
      state.refresh.status = 'failed'
      state.refresh.error = 'Measurement stopped because configuration or results could not be read or saved.'
    } finally {
      state.refresh.currentModel = null
      state.refresh.finishedAt = now()
      try { await save() } finally { await lock.release() }
    }
  }
  async function begin () {
    const lock = await acquire(file + '.lock', { purpose: 'model-performance' }).catch(error => { throw Object.assign(error, { status: 409 }) })
    try {
      const cfg = await load()
      if (cfg.errors.length) throw Object.assign(new Error('Fix configuration errors before measuring models.'), { status: 422 })
      const models = []
      for (const m of cfg.roster.values()) if (m.verification?.status === 'verified' && !await availability.check(m.id)) models.push(m)
      controller = new AbortController()
      if (closed) controller.abort()
      state.refresh = { id: crypto.randomUUID(), status: 'running', startedAt: now(), finishedAt: null,
        total: models.length, completed: 0, failed: 0, skipped: cfg.roster.size - models.length, currentModel: null }
      await save()
      running = run(models, lock).catch(() => { state.refresh.status = 'failed' }).finally(() => { running = null })
    } catch (error) { await lock.release(); throw error }
  }
  return {
    snapshot,
    async refresh () {
      if (closed) throw Object.assign(new Error('Server is stopping'), { status: 503 })
      if (!running && !starting) starting = begin().finally(() => { starting = null })
      if (starting) await starting
      return snapshot()
    },
    async wait () { await starting; await running; return snapshot() },
    async shutdown () { closed = true; await starting; controller?.abort(); await running }
  }
}
