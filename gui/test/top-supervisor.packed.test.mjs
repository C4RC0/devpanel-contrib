import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createTopSupervisor } from '../server/top-supervisor.mjs'

const wait = async (test) => { const end = Date.now() + 4000; while (!test()) { if (Date.now() > end) throw Error('Timed out'); await new Promise((r) => setTimeout(r, 10)) } }

// An answered inquiry packs itself once its run settles, after which that run
// is no longer readable (404). Monitoring must drop it and keep watching the
// others, not fail every poll ("Monitoring: no such run" every few seconds
// while a new run goes unobserved).
export default async function (t) {
  t.section('a settled run whose issue was packed does not blind monitoring')
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-supervisor-packed-'))
  const runs = new Map(), packed = new Set(), invocations = []
  let script = [], starts = 0
  const models = async () => [{ id: 'test-model', title: 'Test model', model: 'wire-model', defaultEffort: 'high', verification: { status: 'verified' } }]
  const adapter = { invoke: async (args) => {
    invocations.push(args)
    const event = JSON.parse(args.prompt).event
    const action = script.shift()?.(event) ?? null
    return { session: args.session ?? { id: 's' }, response: JSON.stringify({ message: 'ok', action }), usage: { costUsd: 0 } }
  } }
  const tools = { projects: async () => [{ id: 'p' }], playbooks: async () => [], infrastructure: async () => ({}), seatModels: async () => [],
    listIssues: async () => [{ id: 'a' }, { id: 'b' }], getIssue: async () => ({ name: 'x' }),
    preview: async () => ({ ok: true, configHash: 'h' }),
    start: async () => { const r = { runId: 'r' + ++starts, status: 'running' }; runs.set(r.runId, r); return r },
    getRun: async (_p, _i, id) => { if (packed.has(id)) throw Object.assign(new Error('no such run'), { status: 404 }); return { ...runs.get(id) } },
    stop: async () => {}, archive: async () => {}, createIssue: async () => ({ id: 'c' }), addNote: async () => ({ number: '000' }) }
  const agent = await createTopSupervisor({ dir, models, adapter, tools, pollMs: 20 })
  try {
    // Event-driven, so a run-changed wake between the two steps cannot shift them.
    let target = null
    const startOn = (issueId) => { target = issueId; return [] }
    script = { shift: () => (e) => {
      if (!target) return null
      if (e.result?.previewId) { const issueId = target; target = null; return { type: 'start_run', project: 'p', issueId, previewId: e.result.previewId } }
      if (e.type === 'user') return { type: 'preview', project: 'p', issueId: target, playbook: 'x' }
      return null
    } }
    startOn('a')
    await agent.start({ model: 'test-model', projects: ['p'], message: 'go', limits: { maxCalls: 50, maxRuns: 5, maxConcurrent: 1, maxStartsPerIssue: 2 } })
    await wait(() => starts === 1 && agent.get().status === 'active')
    runs.get('r1').status = 'completed'
    await wait(() => agent.get().ownedRuns.find((r) => r.runId === 'r1')?.observedStatus === 'completed' && agent.get().status === 'active')
    packed.add('r1')
    startOn('b')
    await agent.chat('next')
    await wait(() => starts === 2 && agent.get().status === 'active')
    const before = invocations.length
    runs.get('r2').status = 'completed'
    // The start's own tool result is delivered first; the ending wakes it after.
    const woke = () => invocations.slice(before).some((i) => JSON.parse(i.prompt).event.type === 'run-changed')
    await wait(() => woke() && agent.get().status === 'active').catch(() => {})
    t.ok('the other run\'s ending still wakes the supervisor', woke(), invocations.slice(before).map((i) => JSON.parse(i.prompt).event.type).join(', '))
    t.ok('the packed run is no longer owned', !agent.get().ownedRuns.some((r) => r.runId === 'r1'))
    t.ok('and monitoring did not fail', !agent.get().messages.some((m) => /Monitoring: no such run/.test(m.text)))
    await agent.stop()
    t.eq('stopping does not mistake the packed run for a recovery', agent.get().status, 'stopped')
  } finally {
    await agent.shutdown?.()
    await fs.rm(dir, { recursive: true, force: true })
  }
}
