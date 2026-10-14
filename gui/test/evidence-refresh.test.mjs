import { engineFixture, scriptFor, blocking } from './fakes/fixture.mjs'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { Engine, previousWindowReports } from '../server/runtime/engine.mjs'

const fence = o => '```json\n' + JSON.stringify(o) + '\n```'
const revision = p => p.match(/Current revision: (sha256:[a-f0-9]{64})/)?.[1] ?? null
export default async t => {
  const seen = []
  let implementations = 0
  const fallback = scriptFor()
  const f = await engineFixture({ playbook: 'implementation', script: turn => {
    seen.push(turn)
    if (turn.stepId.startsWith('brief')) return fence({ targetRole: 'implementer', prompt: 'Fix outstanding findings.', windowDecision: implementations === 1 ? 'refresh-evidence' : 'keep' })
    if (turn.stepId === 'implement') { implementations++; return fence({ summary: 'Fixed', basedOnRevision: revision(turn.prompt) }) }
    if (turn.stepId.startsWith('audit-')) return fence({ verdict: implementations === 1 ? 'changes-needed' : 'approved', artifactRevision: revision(turn.prompt), findings: implementations === 1 ? [blocking('auditor-1-refresh-regression')] : [], priorFindings: [{ id: 'auditor-1-refresh-regression', disposition: 'addressed', reason: 'Fixed' }] })
    if (turn.stepId === 'confirm') return fence({ satisfied: true, criteria: [{ id: 'AC1', met: true }], revision: revision(turn.prompt) })
    return fallback(turn)
  } })
  const options = { participants: { 'auditor-1': { model: 'gpt-6-astra' } } }
  const engine = await startRun({ expectConfigHash: (await resolvePlaybook(f.playbookId, { root: f.configRoot, runOptions: options, projectId: 'devpanel-project' })).resolved.configHash,
    playbookId: f.playbookId, issue: { ...f.issue, project: 'devpanel-project' }, issuePath: f.issuePath, projectPath: f.projectPath,
    harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe,
    clock: f.clock, deliveryProvider: f.delivery, runOptions: options })
  await engine.drive()
  t.eq('repeated refresh cannot starve the correcting worker', engine.run.status, 'completed')
  t.eq('two implementations', implementations, 2)
  t.eq('only one refresh resets triage', seen.filter(s => s.stepId === 'triage').length, 2)
  t.ok('ignored repeat is recorded', Object.values(engine.run.coordinatorEffects).some(e => e.ignored?.includes('refresh-evidence: awaiting worker progress')))
  const secondWriter = seen.filter(s => s.stepId === 'implement')[1]
  t.ok('writer retains concrete previous-window finding', secondWriter?.prompt.includes('auditor-1-refresh-regression'))
  t.ok('historical reports explicitly cannot approve', secondWriter?.prompt.includes('do not establish current approval'))
  t.ok('only fresh reviews approve', engine.run.approvals.length > 0 && engine.run.approvals.every(a => a.step > engine.run.windowResetAfter))
  t.eq('new seat reports replace historical context', previousWindowReports(engine.snapshot, engine.run, engine.activeSteps(), engine.outputs), [])
  await releaseWorkspace(engine)

  // Reconstruct the stalled persisted state: no in-memory counter can protect it.
  const resumed = Object.create(Engine.prototype)
  resumed.snapshot = { tactic: 'implementation' }
  resumed.run = { steps: [{ number: 10, role: 'coordinator' }, { number: 11, role: 'coordinator' }], windowResetAfter: 10,
    coordinatorEffects: { 10: { reset: 'evidence' } }, currentWindow: { id: 'retained' } }
  resumed.outputs = { 11: { valid: true, contract: 'handoff', output: { windowDecision: 'refresh-evidence' } } }
  resumed.clock = { iso: () => 'now' }
  resumed.persist = async () => {}
  await resumed.applyCoordinatorEffects()
  t.eq('persisted refresh protects resumed runs too', resumed.run.windowResetAfter, 10)
  t.ok('pending handoff remains active for worker', resumed.activeSteps().some(s => s.number === 11))
}
