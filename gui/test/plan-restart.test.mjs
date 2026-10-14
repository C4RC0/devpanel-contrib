import { engineFixture, scriptFor, blocking, cleanupFixtures } from './fakes/fixture.mjs'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'

export const name = 'plan restarts — restartPlan reopens planning from implementation only; plan review keeps its round cap'

const start = async (f, options = {}) => startRun({
  expectConfigHash: (await resolvePlaybook(f.playbookId, { root: f.configRoot, runOptions: options, projectId: 'devpanel-project' })).resolved.configHash,
  playbookId: f.playbookId, issue: { ...f.issue, project: 'devpanel-project' }, issuePath: f.issuePath, projectPath: f.projectPath,
  harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe,
  clock: f.clock, deliveryProvider: f.delivery, runOptions: options
})
const oneAuditor = { participants: { 'auditor-1': { model: 'gpt-6-astra' } } }

const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```'
const revision = (p) => (p.match(/Current revision: (sha256:[a-f0-9]{64})/) ?? [])[1] ?? null

// One auditor seat, numbered as the tactic numbers it. `planFindings(round)`
// and `implFindings(round)` script the reviews; `restart(turn)` says when the
// coordinator's brief declares the plan materially wrong.
function script ({ planFindings = () => [], implFindings = () => [], restart = () => false } = {}) {
  const fallback = scriptFor()
  return (turn) => {
    const { stepId, round, prompt } = turn
    if (stepId.startsWith('brief')) return fence({ targetRole: 'worker', prompt: `Round ${round}.`, windowDecision: 'keep', ...(restart(turn) ? { restartPlan: true } : {}) })
    if (stepId.startsWith('audit-plan')) { const findings = planFindings(round); return fence({ verdict: findings.length ? 'changes-needed' : 'approved', artifactRevision: null, findings }) }
    if (stepId.startsWith('audit-implement')) {
      const findings = implFindings(round)
      const prior = [...new Set([0, 1, 2, 3, 4].flatMap((r) => planFindings(r)).map((f) => f.id))].map((id) => ({ id, disposition: 'addressed', reason: 'fixed' }))
      return fence({ verdict: findings.length ? 'changes-needed' : 'approved', artifactRevision: revision(prompt), findings, priorFindings: prior })
    }
    if (stepId === 'implement') return fence({ summary: 'Implemented', basedOnRevision: revision(prompt) })
    if (stepId === 'confirm') return fence({ satisfied: true, criteria: [{ id: 'AC1', met: true }], ...(revision(prompt) ? { revision: revision(prompt) } : {}) })
    return fallback(turn)
  }
}

/*
 * A long run once produced thirteen plan drafts, every one at round 0: the coordinator set
 * restartPlan on each plan-review brief, the engine reset the window and the
 * round counter each time, and the loop's maxRounds: 5 never engaged. The flag
 * exists for the implementation phase, where a writer finds the approved plan
 * materially wrong; a plan needing another round already has the loop.
 */
export default async (t) => {
  t.section('1. restartPlan on a plan-review brief is ignored on record, and the round cap holds')
  {
    const f = await engineFixture({
      playbook: 'plan-and-implement',
      script: script({ planFindings: () => [blocking('auditor-1-never-happy')], restart: (turn) => turn.stepId === 'brief-plan' })
    })
    const engine = await start(f, oneAuditor)
    const run = await engine.drive()
    const cap = engine.snapshot.phases.find((p) => p.id === 'plan-review').loop.maxRounds
    // The same finding every round is not convergence: no extra round, no question.
    t.eq('the plan loop exhausts instead of restarting forever, leaving the issue unresolved', `${run.status}/${run.blockedReason}/${run.outcome}`, 'blocked/rounds-exhausted/unresolved')
    t.eq('nobody was asked', run.steps.filter((s) => s.role === 'operator').length, 0)
    const drafts = run.steps.filter((s) => s.stepId === 'plan')
    t.eq('exactly maxRounds drafts were written', drafts.length, cap)
    t.eq('and they advance the round counter', drafts.map((s) => s.round), [...Array(cap).keys()])
    t.eq('triage ran once: nothing was restarted', run.steps.filter((s) => s.stepId === 'triage').length, 1)
    t.eq('no window reset was recorded', run.windowResetAfter ?? null, null)
    const briefs = run.steps.filter((s) => s.stepId === 'brief-plan')
    t.ok('every ignored request is on the record', briefs.length > 0 && briefs.every((s) => run.coordinatorEffects[s.number]?.ignored?.includes('restartPlan')), JSON.stringify(briefs.map((s) => run.coordinatorEffects[s.number])))
    t.ok('the finding of the last round is still outstanding, not cleared by a restart', run.outstandingFindings.some((x) => x.id === 'auditor-1-never-happy'), JSON.stringify(run.outstandingFindings.map((x) => x.id)))
    t.eq('nothing was implemented against an unapproved plan', run.steps.filter((s) => s.stepId === 'implement').length, 0)
    await releaseWorkspace(engine)
  }

  t.section('2. restartPlan from an implementation brief still reopens the whole plan cycle')
  {
    // First implementation round finds a defect; the coordinator's next
    // implementation brief declares the approved plan materially wrong.
    // Rounds start again at 0 after the restart, so the script keys on whether
    // it has restarted yet, the way a real coordinator asks once.
    let restarted = false
    const f = await engineFixture({
      playbook: 'plan-and-implement',
      script: script({
        implFindings: (round) => !restarted && round === 0 ? [blocking('auditor-1-plan-was-wrong')] : [],
        restart: (turn) => turn.stepId === 'brief-implement' && turn.round === 1 && !restarted && (restarted = true)
      })
    })
    const engine = await start(f, oneAuditor)
    const run = await engine.drive()
    t.eq('the run completes after replanning', run.status, 'completed', run.blockedReason ?? '')
    const ids = run.steps.map((s) => s.stepId)
    const restartAt = run.steps.find((s) => s.stepId === 'brief-implement' && s.round === 1)?.number
    t.ok('the restarting brief is recorded as an honoured effect', restartAt && run.coordinatorEffects[restartAt] && !run.coordinatorEffects[restartAt].ignored, JSON.stringify(run.coordinatorEffects[restartAt]))
    t.eq('the window reset follows that brief', run.windowResetAfter, restartAt)
    t.eq('planning happened twice: once before, once after the restart', ids.filter((x) => x === 'plan').length, 2)
    t.ok('the second plan draft comes after the implementation review that motivated it', run.steps.filter((s) => s.stepId === 'plan').at(-1).number > restartAt, ids.join(','))
    t.ok('and it was audited again before the new implementation', (() => { const p = run.steps.filter((s) => s.stepId === 'plan').at(-1).number; const a = run.steps.find((s) => s.stepId === 'audit-plan-1' && s.number > p); const i = run.steps.find((s) => s.stepId === 'implement' && s.number > p); return a && i && a.number < i.number })(), ids.join(','))
    t.ok('every approval on record is from after the restart', run.approvals.every((a) => a.step > restartAt), JSON.stringify(run.approvals))
    await releaseWorkspace(engine)
  }

  await cleanupFixtures()
}
