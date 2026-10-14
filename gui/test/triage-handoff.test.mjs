import { engineFixture, scriptFor, blocking } from './fakes/fixture.mjs'
import { startRun, resumeRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { firstBriefAfterTriage } from '../server/runtime/engine.mjs'

const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```'
const revision = (p) => (p.match(/Current revision: (sha256:[a-f0-9]{64})/) ?? [])[1] ?? null

function script (seen, { withHandoff = true, rejectFirst = true } = {}) {
  return async (turn) => {
    const { stepId, role, round, prompt } = turn
    seen.push({ stepId, role, round, prompt })
    if (stepId === 'triage') {
      return fence({ fit: true, reasoning: 'Fits.', acceptanceCriteria: [{ id: 'AC1', statement: 'Works' }], suggestion: { action: 'continue', reason: 'go' }, autonomy: { verdict: 'autonomous', reason: 'one run' },
        ...(withHandoff ? { firstHandoff: { targetRole: 'implementer', prompt: 'FIRST-ASSIGNMENT: implement AC1 and report the evidence.', windowDecision: 'keep' } } : {}) })
    }
    if (stepId.startsWith('brief')) return fence({ targetRole: 'implementer', prompt: `BRIEF-ROUND-${round}: address the findings.`, windowDecision: 'keep' })
    if (stepId === 'implement') return fence({ summary: 'Implemented', basedOnRevision: revision(prompt) })
    if (stepId.startsWith('audit-')) {
      const findings = rejectFirst && round === 0 ? [blocking('auditor-1-gap')] : []
      return fence({ verdict: findings.length ? 'changes-needed' : 'approved', artifactRevision: revision(prompt), findings, priorFindings: [] })
    }
    if (stepId === 'confirm') return fence({ satisfied: true, criteria: [{ id: 'AC1', met: true }], revision: revision(prompt) })
    return scriptFor()(turn)
  }
}

async function run (options = {}) {
  const seen = []
  const f = await engineFixture({ playbook: 'implementation', script: script(seen, options) })
  const runOptions = { participants: { 'auditor-1': { model: 'gpt-6-astra' } } }
  const resolved = await resolvePlaybook('implementation', { root: f.configRoot, runOptions, projectId: 'devpanel-project' })
  const engine = await startRun({ expectConfigHash: resolved.resolved.configHash, playbookId: 'implementation', issue: { ...f.issue, project: 'devpanel-project' },
    issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider,
    configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery, runOptions })
  return { f, engine, seen }
}

export default async function (t) {
  t.section('the brief that follows triage is found from the strategy')
  {
    const { engine } = await run()
    const brief = firstBriefAfterTriage(engine.snapshot)
    t.eq('implementation: brief-implement, for the implementer', [brief?.step.id, brief?.targetRole], ['brief-implement', 'implementer'])
    await releaseWorkspace(engine)
  }

  t.section('a triage that writes the first handoff saves the round-0 brief turn')
  {
    const { engine, seen } = await run()
    await engine.drive()
    t.eq('the run completes', engine.run.status, 'completed', engine.run.blockedReason)
    const triagePrompt = seen.find((s) => s.stepId === 'triage').prompt
    t.ok('triage was asked for it, naming the seat', triagePrompt.includes('firstHandoff') && triagePrompt.includes('`implementer`'))
    t.eq('no coordinator was invoked for the round-0 brief', seen.filter((s) => s.stepId === 'brief-implement' && s.round === 0).length, 0)
    t.eq('the round-1 brief, after a finding, is still written by the coordinator', seen.filter((s) => s.stepId === 'brief-implement' && s.round === 1).length, 1)
    const derived = engine.run.steps.find((s) => s.stepId === 'brief-implement' && s.round === 0)
    t.ok('the brief is on the record, derived from the triage step', derived && derived.derivedFrom === engine.run.steps.find((s) => s.stepId === 'triage').number)
    t.eq('its output is a valid handoff', engine.outputs[derived.number]?.valid, true)
    const implement0 = seen.find((s) => s.stepId === 'implement' && s.round === 0)
    t.ok('the implementer received the assignment written at triage', implement0.prompt.includes('FIRST-ASSIGNMENT'))
    t.eq('it cost no invocation and no tokens', [derived.usage, derived.durationMs], [null, 0])
    await releaseWorkspace(engine)
  }

  t.section('without it, the brief turn runs as before')
  {
    const { engine, seen } = await run({ withHandoff: false, rejectFirst: false })
    await engine.drive()
    t.eq('the run completes', engine.run.status, 'completed')
    t.eq('the coordinator wrote the round-0 brief', seen.filter((s) => s.stepId === 'brief-implement' && s.round === 0).length, 1)
    await releaseWorkspace(engine)
  }

  t.section('a crash between deriving and recording re-derives, never blocks')
  {
    const { f, engine } = await run({ rejectFirst: false })
    engine.hooks.afterPersistBeforeAdvance = async (e) => {
      if (e.run.steps.some((s) => s.stepId === 'triage')) { delete e.hooks.afterPersistBeforeAdvance }
    }
    await engine.drive({ maxTurns: 1 })   // triage only
    // Model a pending derived brief left by a process that died mid-commit.
    engine.run.participants.coordinator.pendingInvocation = { invocationId: 'triage-handoff-x', derivedFrom: '001', cursor: { stepId: 'brief-implement', round: 0, attempt: 1 } }
    await engine.saveRun()
    const resumed = await resumeRun({ issuePath: f.issuePath, runId: engine.runId, harnesses: f.harnesses, stepStore: f.stepStore, clock: f.clock, configRoot: f.configRoot, deliveryProvider: f.delivery, workspaceProvider: f.workspaceProvider, projectPath: f.projectPath, takeLock: false })
    await resumed.recover()
    t.eq('recovery clears it instead of blocking', [resumed.run.status !== 'blocked', resumed.run.participants.coordinator.pendingInvocation], [true, null])
    await resumed.drive()
    t.eq('and the run completes', resumed.run.status, 'completed', resumed.run.blockedReason)
    await releaseWorkspace(resumed)
  }
}
