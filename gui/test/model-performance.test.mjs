import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createModelPerformanceService, modelFingerprint, performanceForModel } from '../server/model-performance.mjs'
import { availabilityReport } from '../server/availability-api.mjs'
import { CONFIG_ROOT } from './helpers.mjs'

export default async function (t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-performance-test-'))
  const verified = id => ({ id, model: id + '-wire', harness: 'fake', verification: { status: 'verified' } })
  const good = { ...verified('good'), profile: 'provider', credentialRef: 'env:TEST_KEY', endpointRef: 'env:TEST_URL', defaultEffort: 'low' }
  let models = [good, verified('held'), { ...verified('unverified'), verification: { status: 'unverified' } }]
  const file = path.join(dir, 'performance.json')
  let time = 0, calls = [], release
  const gate = new Promise(resolve => { release = resolve })
  const availability = { check: async id => id === 'held', all: async () => [] }
  const service = await createModelPerformanceService({ file, availability,
    load: async () => ({ errors: [], roster: new Map(models.map(m => [m.id, m])) }),
    monotonic: () => time,
    loadAdapter: async () => ({ invoke: async args => {
      calls.push(args)
      time = 10; args.observe.onActivity({ kind: 'spawned' })
      time = 50; args.observe.onActivity({ kind: 'system' })
      time = 90; args.observe.onActivity({ kind: 'system' })
      time = 250; args.observe.onActivity({ kind: 'text' })
      time = 300; args.observe.onActivity({ kind: 'text' })
      await gate
      time = 400
      return { response: 'A peaceful walk in the park. '.repeat(34), outcome: 'completed', usage: { tokens: 300, outputTokens: 280, costUsd: 0.001 } }
    } })
  })
  try {
    t.section('explicit bounded refresh, precise event timing and persistence')
    t.eq('reading starts no calls', [service.snapshot().refresh, calls.length], [null, 0])
    const [a, b] = await Promise.all([service.refresh(), service.refresh()])
    t.eq('simultaneous refresh joins one batch', a.refresh.id, b.refresh.id)
    t.eq('only verified available models eligible', a.refresh.total, 1)
    while (!calls.length) await new Promise(resolve => setTimeout(resolve, 1))
    t.eq('refresh while running joins batch', (await service.refresh()).refresh.id, a.refresh.id)
    release()
    const result = await service.wait()
    t.eq('one invocation only', calls.length, 1)
    t.eq('startup uses first ready, not spawn', result.models.good.startupMs, 50)
    t.eq('response uses first text, not last', result.models.good.responseMs, 200)
    t.eq('turnaround includes completion', result.models.good.totalMs, 400)
    t.eq('successful sample has usage', [result.models.good.status, result.models.good.tokens, result.models.good.costUsd], ['ok', 300, 0.001])
    t.eq('response length records words and output tokens', [result.models.good.responseWords, result.models.good.outputTokens], [204, 280])
    t.eq('rate uses output tokens and excludes startup', result.models.good.tokensPerSecond, 800)
    t.eq('fresh session with no tool permissions', [calls[0].session, calls[0].supervisorOnly], [null, true])
    t.eq('connection and effort reach adapter', [calls[0].profile, calls[0].credentialRef, calls[0].endpointRef, calls[0].effort], ['provider', 'env:TEST_KEY', 'env:TEST_URL', 'low'])
    t.eq('temporary workspace removed', await fs.stat(calls[0].cwd).then(() => true, () => false), false)
    t.eq('samples saved to disk', JSON.parse(await fs.readFile(file, 'utf8')).models.good.totalMs, 400)
    t.eq('matching model not stale', performanceForModel(result, good).stale, false)
    t.eq('changed connection invalidates sample', performanceForModel(result, { ...good, account: 'other' }).stale, true)
    const copy = service.snapshot(); copy.models.good.totalMs = 999
    t.eq('readers cannot mutate saved samples', service.snapshot().models.good.totalMs, 400)
    time = 0
    const next = await service.refresh()
    await service.wait()
    t.ok('refresh after completion starts a new batch', next.refresh.id !== a.refresh.id)
    t.eq('new refresh remeasures the model', calls.length, 2)
    const restarted = await createModelPerformanceService({ file, availability })
    t.eq('restart retains token rate', restarted.snapshot().models.good.tokensPerSecond, 800)
    t.eq('restart retains samples without calls', restarted.snapshot().models.good.totalMs, 400)
    await restarted.shutdown()
    const report = await availabilityReport({ store: availability, performance: service, configRoot: CONFIG_ROOT })
    t.eq('page exposes shared measurement definitions', report.performance.definitions.responseMs, result.definitions.responseMs)
  } finally { await service.shutdown() }

  t.section('failures remain failures, never synthetic successful measurements')
  models = ['missing', 'invalid', 'failed', 'timeout'].map(verified)
  const failed = await createModelPerformanceService({ file: path.join(dir, 'failures.json'), availability,
    timeoutMs: 20,
    load: async () => ({ errors: [], roster: new Map(models.map(m => [m.id, m])) }),
    loadAdapter: async () => ({ invoke: async args => {
      if (args.model === 'missing-wire') return { response: 'A peaceful walk in the park. '.repeat(34) }
      if (args.model === 'invalid-wire') return { response: 'Hello world.', usage: { outputTokens: 3 } }
      if (args.model === 'failed-wire') throw new Error('SECRET-PROVIDER-CREDENTIAL')
      await new Promise((resolve, reject) => args.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    } })
  })
  try {
    await failed.refresh(); const result = await failed.wait()
    t.eq('no ready/text events remain unknown', [result.models.missing.startupMs, result.models.missing.responseMs], [null, null])
    t.eq('missing output usage remains unknown', result.models.missing.tokensPerSecond, null)
    t.ok('unsuccessful samples have no token rate', ['invalid', 'failed', 'timeout'].every(id => result.models[id].tokensPerSecond === null))
    t.eq('wrong answer is not success', result.models.invalid.status, 'invalid-response')
    t.eq('runtime failure is recorded', result.models.failed.status, 'error')
    t.eq('timeout aborts invocation', result.models.timeout.status, 'timeout')
    t.eq('batch proceeds across failures', [result.refresh.completed, result.refresh.failed], [4, 3])
    t.ok('raw provider errors cannot leak into stored samples', !(await fs.readFile(path.join(dir, 'failures.json'), 'utf8')).includes('SECRET-PROVIDER-CREDENTIAL'))
  } finally { await failed.shutdown() }

  t.section('unknown or zero measurement inputs do not produce misleading rates')
  for (const [label, outputTokens, hasReady, elapsed, expected] of [
    ['missing usage', undefined, true, 100, null],
    ['missing readiness', 280, false, 100, null],
    ['zero duration', 280, true, 0, null],
    ['negative usage', -1, true, 100, null],
    ['non-finite usage', Infinity, true, 100, null]
  ]) {
    let clock = 0
    const edge = await createModelPerformanceService({ file: path.join(dir, `${label}.json`), availability,
      load: async () => ({ errors: [], roster: new Map([['good', good]]) }),
      monotonic: () => clock,
      loadAdapter: async () => ({ invoke: async args => {
        if (hasReady) args.observe.onActivity({ kind: 'system' })
        clock = elapsed
        return { response: 'A peaceful walk in the park. '.repeat(34), usage: { outputTokens } }
      } })
    })
    try {
      await edge.refresh()
      t.eq(label, (await edge.wait()).models.good.tokensPerSecond, expected)
    } finally { await edge.shutdown() }
  }

  t.section('shutdown cancels and waits; a new refresh after completion remeasures')
  let began
  const entered = new Promise(resolve => { began = resolve })
  const stopped = await createModelPerformanceService({ file: path.join(dir, 'stop.json'), availability,
    load: async () => ({ errors: [], roster: new Map([['good', good]]) }),
    loadAdapter: async () => ({ invoke: args => new Promise((resolve, reject) => {
      began(); args.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
    }) })
  })
  await stopped.refresh(); await entered; await stopped.shutdown()
  t.eq('shutdown saves cancelled status', [stopped.snapshot().refresh.status, stopped.snapshot().models.good.status], ['cancelled', 'cancelled'])
  let thrown
  try { await stopped.refresh() } catch (e) { thrown = e }
  t.eq('no refresh after shutdown', thrown?.status, 503)
  t.ok('fingerprint does not contain credential reference text', !modelFingerprint(good).includes('TEST_KEY'))
  await fs.rm(dir, { recursive: true, force: true })
}
