import { engineFixture, scriptFor, blocking } from './fakes/fixture.mjs'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { readEvents } from '../server/runtime/store.mjs'

const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```'
const revision = (p) => (p.match(/Current revision: (sha256:[a-f0-9]{64})/) ?? [])[1] ?? null
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const start = async (f, options) => startRun({
  expectConfigHash: (await resolvePlaybook(f.playbookId, { root: f.configRoot, runOptions: options, projectId: 'devpanel-project' })).resolved.configHash,
  playbookId: f.playbookId, issue: { ...f.issue, project: 'devpanel-project' }, issuePath: f.issuePath, projectPath: f.projectPath,
  harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe,
  clock: f.clock, deliveryProvider: f.delivery, runOptions: options
})

/** Audits take a while and log when they ran; auditor-1 rejects the first round. */
function script (log, { rejectFirst = true, failSeat = null } = {}) {
  return async (turn) => {
    const { stepId, role, round, prompt } = turn
    if (stepId.startsWith('brief')) return fence({ targetRole: 'worker', prompt: 'Do the work.', windowDecision: 'keep' })
    if (stepId === 'implement') return fence({ summary: 'Implemented', basedOnRevision: revision(prompt) })
    if (stepId.startsWith('audit-')) {
      const entry = { role, round, stepId, from: Date.now() }
      log.push(entry)
      await sleep(150)
      entry.to = Date.now()
      if (failSeat === role) throw Object.assign(new Error('simulated auditor crash'), { code: 1 })
      const findings = rejectFirst && role === 'auditor-1' && round === 0 ? [blocking('auditor-1-gap')] : []
      return fence({ verdict: findings.length ? 'changes-needed' : 'approved', artifactRevision: stepId.includes('implement') ? revision(prompt) : null, findings, priorFindings: [] })
    }
    if (stepId === 'confirm') return fence({ satisfied: true, criteria: [{ id: 'AC1', met: true }], ...(revision(prompt) ? { revision: revision(prompt) } : {}) })
    return scriptFor()(turn)
  }
}

const overlapped = (log, round) => {
  const r = log.filter((e) => e.round === round)
  return r.length > 1 && r.every((a) => r.every((b) => a === b || (a.from < b.to && b.from < a.to)))
}

export default async function (t) {
  const seats = { participants: { 'auditor-1': { model: 'gpt-6-astra' }, 'auditor-2': { model: 'gpt-6-astra' }, 'auditor-3': { model: 'gpt-6-astra' } } }

  t.section('occupied auditors of one round run at once, and consensus is unchanged')
  {
    const log = []
    const f = await engineFixture({ playbook: 'implementation', script: script(log) })
    const engine = await start(f, seats)
    await engine.drive()
    t.eq('the run completes', engine.run.status, 'completed', engine.run.blockedReason)
    t.eq('one auditor\'s finding still sends the author round again', engine.run.steps.filter((s) => s.stepId === 'implement').length, 2)
    t.eq('every auditor reviewed both rounds', log.length, 6)
    t.ok('the first round\'s three audits overlapped', overlapped(log, 0), JSON.stringify(log))
    t.ok('and so did the second\'s', overlapped(log, 1))
    t.eq('every seat approved the final revision', engine.run.approvals.map((a) => a.role).sort(), ['auditor-1', 'auditor-2', 'auditor-3'])
    const { events } = await readEvents(f.issuePath, engine.runId)
    t.eq('each batch is on the record', events.filter((e) => e.type === 'concurrent-reviews').length, 2)
    t.eq('the journal is intact after concurrent writes', events.every((e) => e.type), true)
    await releaseWorkspace(engine)
  }

  t.section('a strategy may keep them serial')
  {
    const log = []
    const f = await engineFixture({ playbook: 'implementation', script: script(log, { rejectFirst: false }) })
    const engine = await start(f, seats)
    engine.snapshot.reviewPolicy = { ...engine.snapshot.reviewPolicy, concurrentReviews: false }
    await engine.drive()
    t.eq('the run completes', engine.run.status, 'completed')
    t.eq('no two audits overlapped', overlapped(log, 0), false)
    await releaseWorkspace(engine)
  }

  t.section('a failing seat waits for the others and fails the run once')
  {
    const log = []
    const f = await engineFixture({ playbook: 'implementation', script: script(log, { rejectFirst: false, failSeat: 'auditor-2' }) })
    const engine = await start(f, seats)
    const thrown = await engine.drive().then(() => null, (e) => e)
    t.ok('the failure surfaces', thrown || engine.run.failure, thrown?.message)
    t.ok('the other audits of the batch finished before it did', log.filter((e) => e.round === 0).every((e) => e.to), JSON.stringify(log))
    t.eq('nothing is left in flight', Object.values(engine.run.participants).filter((p) => p.pendingInvocation).length, 0)
    await releaseWorkspace(engine)
  }
}
