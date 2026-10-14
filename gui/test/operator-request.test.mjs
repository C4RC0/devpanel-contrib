import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { engineFixture, scriptFor, cleanupFixtures } from './fakes/fixture.mjs'

export const name = 'operator requests — work the run cannot do for itself stops the run and asks'

const launch = (f, extra = {}) => startRun({
  playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id },
  issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore,
  workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery, ...extra
})

/*
 * A participant's workspace is an isolated worktree whose content IS the
 * revision's identity, so nothing in a run may reach the live checkout: a
 * commit there would change what the fingerprint measures and what the patch
 * rebuilds. The coordinator is not therefore mute about it — it can name the
 * work in its handoff, and the engine stops the run and asks for it.
 */
export default async (t) => {
  t.section('1. the coordinator can ask for work only the live checkout can take, and the run waits for it')
  {
    const request = {
      question: 'Commit the live checkout of devpanel-project so a run can be cut from a base commit?',
      reason: 'The checkout has uncommitted changes that the candidate must be measured against.',
      projectAction: 'push',
      category: 'live-checkout',
      recommendation: 'Run the push action, then answer with the commit.'
    }
    const f = await engineFixture({ script: scriptFor({ operatorRequest: { stepId: 'brief-implement', request } }) })
    const engine = await launch(f)
    const run = await engine.drive()
    t.eq('the run is paused, not blocked', `${run.status}/${run.blockedReason}`, 'paused/null')
    t.eq('by the coordinator, from the step that asked', [run.pause?.askedBy?.role, run.pause?.askedBy?.stepId], ['coordinator', 'brief-implement'])
    t.eq('the question is the coordinator\'s own', run.pause?.question, request.question)
    t.eq('free text: work is not a closed choice', run.pause?.options, null)
    t.eq('and the ask says what would do it', [run.pause?.kind, run.pause?.request?.projectAction], ['operator-request', 'push'])
    t.eq('with the reason it cannot proceed', run.pause?.request?.reason, request.reason)
    t.eq('nothing beyond the coordinator turn ran', run.steps.map((s) => s.stepId).join(','), 'triage,brief-implement')

    t.section('   …asking is idempotent: a second drive waits rather than asking again')
    const pauseId = run.pause.id
    const again = await engine.drive()
    t.eq('the same question, not a new one', again.pause?.id, pauseId)
    t.eq('recorded once, against the step that raised it', Object.keys(again.operatorRequests ?? {}).length, 1)

    t.section('   …the answer is a step, and the handoff it authored is delivered afterwards')
    await engine.answer({ pauseId, text: 'Committed it with the push action: 2 files.', actor: 'top-level supervisor' })
    const done = await engine.drive()
    const decision = done.steps.find((s) => s.role === 'operator')?.decision
    t.eq('the decision keeps what was asked for', decision?.request?.projectAction, 'push')
    t.eq('the implementer was briefed after the answer', done.steps.filter((s) => s.stepId === 'implement').length, 1)
    t.ok('and the run carried on past it', done.steps.length > 3, done.steps.map((s) => s.stepId).join(','))
    await releaseWorkspace(engine)
  }

  t.section('2. what the top-level supervisor is shown includes the ask, not just that the run stopped')
  {
    const { summariseRun } = await import('../server/supervisor-summary.mjs')
    const summary = summariseRun({
      runId: 'r', issue: { project: 'p', id: 'i' }, playbook: {}, status: 'paused', steps: [], participants: {},
      pause: { id: 'q1', question: 'Commit the checkout?', options: null, kind: 'operator-request', request: { reason: 'uncommitted changes', projectAction: 'push' } }
    })
    t.eq('the question reaches it', summary.pause?.question, 'Commit the checkout?')
    t.eq('and so does the action that would answer it', summary.pause?.request?.projectAction, 'push')
  }

  t.section('3. a coordinator effect on the same handoff cannot swallow the request')
  {
    // The contract permits both on one handoff, and the window effects are the
    // dangerous pair: restart-required blocks the run, and refresh-evidence or
    // restartPlan move windowResetAfter past the very step that asked, so the
    // request would never be seen again. The ask is therefore processed first.
    const request = { question: 'Commit the live checkout?', reason: 'observed uncommitted work', projectAction: 'push', category: 'live-checkout', recommendation: 'Run push.' }
    const cases = [
      ['restart-required', { windowDecision: 'restart-required' }],
      ['refresh-evidence', { windowDecision: 'refresh-evidence' }],
      ['restartPlan', { restartPlan: true }]
    ]
    for (const [label, effect] of cases) {
      const f = await engineFixture({
        playbook: 'implementation',
        script: scriptFor({ operatorRequest: { stepId: 'brief-implement', request, with: effect } })
      })
      const engine = await launch(f)
      const run = await engine.drive()
      t.eq(`with ${label} on the same handoff, the run still asks`, run.status, 'paused', run.blockedReason ?? '')
      t.eq('and the ask is the coordinator\'s', run.pause?.request?.projectAction, 'push')
      t.eq('recorded against the step that raised it', Object.keys(run.operatorRequests ?? {}).length, 1)
      await engine.answer({ pauseId: run.pause.id, text: 'Committed it.', actor: 'op' })
      const after = await engine.drive()
      // The effect is not discarded by asking first: it applies on the next
      // pass, in its own terms.
      if (label === 'restart-required') {
        t.eq('then the window decision takes effect, in its own order', `${after.status}/${after.blockedReason}`, 'blocked/coordinator-requested-source-refresh')
      } else {
        t.ok('then the window decision takes effect and the run goes on', after.steps.some((s) => s.role === 'operator') && after.status !== 'paused', `${after.status}/${after.steps.map((s) => s.stepId).join(',')}`)
      }
      await releaseWorkspace(engine)
    }
  }

  await cleanupFixtures()
}
