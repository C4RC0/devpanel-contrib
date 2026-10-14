import os from 'node:os'
import { parseSupervisorResponse } from '../server/supervisor-response.mjs'
import { readRun, writeRun } from '../server/runtime/store.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { startRun, resumeRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { plan } from '../server/runtime/engine.mjs'
import { engineFixture, scriptFor, blocking, cleanupFixtures, pausingStrategy } from './fakes/fixture.mjs'
import { patch } from './helpers.mjs'

const NL = String.fromCharCode(10)

const launch = (f, extra = {}) => startRun({
  playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id },
  issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore,
  workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery, ...extra
})

export default async (t) => {
  const action = { type: 'answer_run', project: 'p', issueId: 'i', runId: 'r', answer: 'continue', pauseId: 'question-1' }
  t.eq('supervisor protocol carries the inspected question ID', parseSupervisorResponse(JSON.stringify({ message: 'answer', action })).action.pauseId, 'question-1')
  let rejected = false
  try { parseSupervisorResponse(JSON.stringify({ message: 'answer', action: { ...action, pauseId: undefined } })) } catch { rejected = true }
  t.ok('supervisor protocol refuses an unbound answer', rejected)

  t.section('1. (await-input configuration) triage that needs a decision pauses the run instead of guessing or aborting')
  {
    const f = await engineFixture({ script: scriptFor({ needsInput: 'Should the socket path be configurable or fixed?' }) })
    await pausingStrategy(f.configRoot, { rounds: false })
    const engine = await launch(f)
    const run = await engine.drive()
    t.eq('the run is paused', run.status, 'paused')
    t.eq('with no blocked reason', run.blockedReason, null)
    t.ok('and the question, rendered from the triage output', /Should the socket path/.test(run.pause?.question ?? ''), run.pause?.question)
    t.eq('free text: no closed options', run.pause?.options, null)
    t.eq('attributed to the triage step', run.pause?.askedBy?.stepId, 'triage')
    t.eq('only the triage turn ran', run.steps.length, 1)
    t.ok('nothing is pending on any participant', Object.values(run.participants).every((p) => !p.pendingInvocation))

    t.section('   …a second drive does nothing until someone answers')
    const again = await engine.drive()
    t.eq('still paused', again.status, 'paused')
    t.eq('still one step', again.steps.length, 1)

    t.section('   …an answer is recorded as an operator step and the run continues past the question')
    let refused = null
    try { await engine.answer({ pauseId: engine.run.pause?.id, text: '   ', actor: 'op' }) } catch (error) { refused = error }
    t.eq('an empty answer is refused', refused?.status, 400)
    refused = null
    try { await engine.answer({ pauseId: engine.run.pause?.id, text: 'fixed path', actor: '' }) } catch (error) { refused = error }
    t.eq('an anonymous answer is refused', refused?.status, 400)
    const decision = await engine.answer({ pauseId: engine.run.pause?.id, text: 'Keep the path fixed; make it configurable in a follow-up.', actor: 'Alice' })
    t.eq('the decision names its actor', decision.actor, 'Alice')
    t.eq('the run is pending again', engine.run.status, 'pending')
    t.eq('the pause is cleared', engine.run.pause, null)
    const opStep = engine.run.steps.find((s) => s.role === 'operator')
    t.ok('the answer is a step of its own', Boolean(opStep), JSON.stringify(engine.run.steps.map((s) => s.stepId)))
    t.eq('with the decision on it', opStep?.decision?.answer, 'Keep the path fixed; make it configurable in a follow-up.')
    const folders = await f.stepFolders()
    t.ok('and a folder on disk', folders.some((d) => /-decision$/.test(d)), folders.join(','))
    t.eq('operator steps do not spend the step budget', engine.run.budgets.used.steps, 1)

    const seen = []
    const observing = { ...f.fake, invoke: async (a) => { seen.push(a); return f.fake.invoke(a) } }
    engine.harnesses = { fake: observing }
    const done = await engine.drive()
    t.eq('the run went on to completion', `${done.status}/${done.outcome}`, 'completed/resolved', done.blockedReason)
    t.eq('triage was not repeated', done.steps.filter((s) => s.stepId === 'triage').length, 1)
    const handoff = seen.find((a) => a.meta.stepId === 'brief-implement')
    t.ok('the coordinator was handed the decision', handoff?.prompt.includes('### decisions') && handoff.prompt.includes('Keep the path fixed'), handoff?.prompt.slice(-600))
    const confirm = seen.find((a) => a.meta.stepId === 'confirm')
    t.ok('and so was the closing report', confirm?.prompt.includes('Keep the path fixed'))
    await releaseWorkspace(engine)
  }

  t.section('2. the answer survives a restart: replay sees the operator step, not a cursor')
  {
    const f = await engineFixture({ script: scriptFor({ needsInput: 'Which branch?' }) })
    await pausingStrategy(f.configRoot, { rounds: false })
    const engine = await launch(f)
    await engine.drive()
    delete engine.run.pause.id // A pause persisted by an older server.
    await writeRun(f.issuePath, engine.runId, engine.run)
    engine.run = await readRun(f.issuePath, engine.runId)
    t.ok('historical pause gets an answerable identity', Boolean(engine.run.pause.id))
    t.eq('historical identity is stable across reads', (await readRun(f.issuePath, engine.runId)).pause.id, engine.run.pause.id)
    await engine.answer({ pauseId: engine.run.pause?.id, text: 'main', actor: 'op' })
    await engine.runLock.release()
    const resumed = await resumeRun({ issuePath: f.issuePath, runId: engine.runId, harnesses: f.harnesses, stepStore: f.stepStore, clock: f.clock, deliveryProvider: f.delivery, configRoot: f.configRoot, projectPath: f.projectPath })
    const next = plan(resumed.snapshot, resumed.run.steps, resumed.outputs)
    t.eq('the replayed next turn is past the question', `${next.kind}:${next.step?.id}`, 'turn:brief-implement')
    const run = await resumed.drive()
    t.eq('and the resumed run completes', run.status, 'completed', run.blockedReason)
    await releaseWorkspace(resumed)
  }

  t.section('3. (await-input configuration) round exhaustion can ask instead of block; `continue` buys exactly one round, and the answer must be one of the options')
  {
    // The shipped loop decides by rule now; the sandbox puts it back on asking,
    // and caps it at one round so the question comes after a single audit.
    const f = await engineFixture({ script: scriptFor({ implReviews: [[blocking('F1')]] }) })
    await pausingStrategy(f.configRoot, { triage: false })
    await patch(path.join(f.configRoot, 'playbooks', 'implementation.yaml'),
      'budgets:\n', 'overrides:\n  implement-review.maxRounds: 1\nbudgets:\n')
    const engine = await launch(f)
    const run = await engine.drive()
    t.eq('the run paused at exhaustion', run.status, 'paused', run.blockedReason)
    t.eq('with a closed choice', (run.pause?.options ?? []).join(','), 'continue,stop')
    t.eq('asked by the implementation loop', run.pause?.askedBy?.phase, 'implement-review')
    const audits = run.steps.filter((s) => s.stepId === 'audit-implement-1').length
    // The playbook overrides the loop's round cap; the snapshot says what applied.
    const cap = engine.snapshot.phases.find((p) => p.id === 'implement-review').loop.maxRounds
    t.eq('after the rounds the snapshot allowed', audits, cap)
    let refused = null
    try { await engine.answer({ pauseId: engine.run.pause?.id, text: 'maybe', actor: 'op' }) } catch (error) { refused = error }
    t.eq('prose is refused, never interpreted', refused?.status, 422)
    const oldPauseId = engine.run.pause.id
    await engine.answer({ pauseId: engine.run.pause?.id, text: 'continue', actor: 'op' })
    const more = await engine.drive()
    t.eq('exactly one more round ran', more.steps.filter((s) => s.stepId === 'audit-implement-1').length, audits + 1)
    t.eq('and the run asks again', more.status, 'paused')
    t.ok('each repeated question has a new identity', oldPauseId !== more.pause.id)
    for (const pauseId of [oldPauseId, undefined]) {
      refused = null
      try { await engine.answer({ pauseId, text: 'continue', actor: 'op' }) } catch (error) { refused = error }
      t.eq('stale or unbound answer is refused', refused?.status, 409)
      t.eq('refusal keeps the question pending', engine.run.status, 'paused')
    }
    await engine.answer({ pauseId: engine.run.pause?.id, text: 'stop', actor: 'op' })
    const end = await engine.drive()
    t.eq('stop ends it as round exhaustion', `${end.status}/${end.blockedReason}`, 'blocked/rounds-exhausted')
    t.eq('with both decisions on record', end.steps.filter((s) => s.role === 'operator').length, 2)
    await releaseWorkspace(engine)
  }

  t.section('4. the supervisor resumes a paused run through answer(), keeping its worktree')
  {
    const f = await engineFixture({ script: scriptFor({ needsInput: 'Proceed?' }) })
    await pausingStrategy(f.configRoot, { rounds: false })
    const projectsDir = path.join(f.issuesDir, 'projects')
    await fs.mkdir(projectsDir, { recursive: true })
    await fs.symlink(f.projectPath, path.join(projectsDir, 'devpanel-project'))
    const control = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-fake-control-')), 'control.json')
    await fs.writeFile(control, JSON.stringify({ ledger: path.join(f.issuesDir, 'ledger.jsonl'), delayMs: 0, script: { needsInput: 'Proceed?' } }))
    process.env.DEVPANEL_FAKE_CONTROL = control
    await fs.writeFile(path.join(f.configRoot, 'harness', 'fake.mjs'), `export * from ${JSON.stringify(path.join(process.cwd(), 'test', 'fakes', 'harness-module.mjs'))}${NL}`)
    const { createSupervisor, supportedActions } = await import('../server/supervisor.mjs')
    const supervisor = createSupervisor({ issues: f.issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir, configRoot: f.configRoot })
    // The strategy has to be one that still has the needs-input transition:
    // coordinated-analysis (behind the `analysis` playbook) has no triage step
    // and no await-input, so it would run to completion and prove nothing.
    const started = await supervisor.start({ project: 'devpanel-project', issueId: f.issue.id, playbookId: f.playbookId, configRoot: f.configRoot })
    await supervisor.settle()
    const { readRun } = await import('../server/runtime/store.mjs')
    let run = await readRun(f.issuePath, started.runId)
    t.eq('the supervised run paused', run.status, 'paused')
    t.eq('its worktree was kept for the resume', run.workspace.state, 'retained')
    // Nothing is in flight: the way on is an answer, the way out is abandoning
    // the run. Nothing else is offered — there is no generic resume.
    t.eq('the panel offers answering it or abandoning the run', supportedActions(run).join(','), 'answer,abandon')
    let refused = null
    try { await supervisor.answer({ project: 'devpanel-project', issueId: f.issue.id, runId: started.runId, pauseId: run.pause?.id, text: 'yes', actor: '' }) } catch (error) { refused = error }
    t.eq('an anonymous answer is refused by the supervisor too', refused?.status, 400)
    const answered = await supervisor.answer({ project: 'devpanel-project', issueId: f.issue.id, runId: started.runId, pauseId: run.pause?.id, text: 'yes, proceed', actor: 'op' })
    t.eq('resumed', answered.status, 'pending')
    await supervisor.settle()
    run = await readRun(f.issuePath, started.runId)
    t.eq('the run went on and completed', `${run.status}/${run.outcome}`, 'completed/resolved', run.blockedReason)
    t.ok('with the decision among its steps', run.steps.some((s) => s.role === 'operator' && s.decision.answer === 'yes, proceed'))
    refused = null
    try { await supervisor.answer({ project: 'devpanel-project', issueId: f.issue.id, runId: started.runId, pauseId: run.pause?.id, text: 'again', actor: 'op' }) } catch (error) { refused = error }
    t.eq('a run that is not paused cannot be answered', refused?.status, 409)
    delete process.env.DEVPANEL_FAKE_CONTROL
    await fs.rm(path.dirname(control), { recursive: true, force: true })
  }

  await cleanupFixtures()
}
