import { startRun, resumeRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { readOutputs } from '../server/runtime/store.mjs'
import { engineFixture, scriptFor, blocking, cleanupFixtures, simulateProcessDeath } from './fakes/fixture.mjs'

export const name = 'engine — session continuity and crash recovery'

const start = (f, extra = {}) => startRun({
  playbookId: f.playbookId,
  issue: { project: 'devpanel-project', id: f.issue.id },
  issuePath: f.issuePath,
  projectPath: f.projectPath,
  harnesses: f.harnesses,
  stepStore: f.stepStore,
  workspaceProvider: f.workspaceProvider,
  configRoot: f.configRoot,
  probe: f.probe,
  clock: f.clock,
  configRoot: f.configRoot,
  deliveryProvider: f.delivery,
  ...extra
})

class Crash extends Error {}

/** Ledger entries recording that the runtime actually started a turn. */
const startedFor = async (f, stepId) =>
  (await f.fake.ledger.entries()).filter((e) => e.phase === 'started' && e.stepId === stepId).length

/**
 * Drive until the injected crash fires, then reopen the run the way a restarted
 * server would: a fresh Engine over the persisted state, with no memory of what
 * the previous process was doing.
 */
async function crashAt (f, hookName, when) {
  const engine = await start(f)
  engine.hooks[hookName] = async (e) => { if (when(e)) { delete e.hooks[hookName]; throw new Crash(hookName) } }
  let crashed = false
  try { await engine.drive() } catch (error) { crashed = error instanceof Crash }
  return { engine, crashed, runId: engine.runId }
}

/** Reopen the way a restarted server would, after the old process is gone. */
async function reopen (f, runId) {
  await simulateProcessDeath(f.issuePath)
  return resumeRun({
    issuePath: f.issuePath,
    runId,
    harnesses: f.harnesses,
    stepStore: f.stepStore,
    clock: f.clock,
    configRoot: f.configRoot,
    deliveryProvider: f.delivery,
    workspaceProvider: f.workspaceProvider,
    projectPath: f.projectPath
  })
}

export default async function (t) {
  // ------------------------------------------------------------ continuity
  t.section('session continuity: each participant keeps its own session')
  {
    // Two implementation rounds, so the implementer and auditor both return.
    const f = await engineFixture({ script: scriptFor({ implReviews: [[blocking('F1')], []] }) })
    const engine = await start(f)
    const run = await engine.drive()

    const roles = Object.keys(run.participants)
    t.eq('three participants', roles.length, 3)
    for (const role of roles) {
      const sessions = await f.fake.sessionsFor?.(role) ?? await f.fake.ledger.sessionsFor(role)
      t.eq(`${role} used exactly one session across all its turns`, sessions.length, 1)
      t.eq(`${role}'s recorded session matches the ledger`, run.participants[role].session.id, sessions[0])
    }
    const all = roles.map((r) => run.participants[r].session.id)
    t.eq('the three sessions are distinct', new Set(all).size, 3)
    t.ok('every participant took more than one turn', roles.every((r) => run.participants[r].turns > 1),
      JSON.stringify(Object.fromEntries(roles.map((r) => [r, run.participants[r].turns]))))
    await releaseWorkspace(engine)
  }

  // ------------------------------------------------------------ crash: before
  t.section('crash BEFORE invocation: nothing ran, so retry is safe')
  {
    const f = await engineFixture()
    const { crashed, runId } = await crashAt(f, 'beforeInvoke', (e) => e.run.steps.length === 3)
    t.ok('the crash fired', crashed)
    t.eq('the runtime never started that turn', await startedFor(f, 'audit-implement-1'), 0)

    const resumed = await reopen(f, runId)
    const pendingRole = Object.values(resumed.run.participants).find((p) => p.pendingInvocation)?.role
    t.ok('a pending invocation was left behind', Boolean(pendingRole), pendingRole)

    await resumed.recover()
    t.ok('recovery cleared it as no-work-done',
      resumed.run.participants[pendingRole].pendingInvocation === null)
    t.ok('and did not block the run', resumed.run.status !== 'blocked', resumed.run.blockedReason)

    const run = await resumed.drive()
    t.eq('the turn ran exactly once in total', await startedFor(f, 'audit-implement-1'), 1)
    t.eq('no duplicate step', run.steps.filter((s) => s.stepId === 'audit-implement-1').length, 1)
    t.eq('and the run completes', run.outcome, 'resolved')
    await releaseWorkspace(resumed)
  }

  // ------------------------------------------------------------ crash: after agent
  t.section('crash AFTER the agent finished but BEFORE persistence: adopt, do not repeat')
  {
    const f = await engineFixture()
    const { crashed, runId } = await crashAt(f, 'afterInvokeBeforePersist', (e) => e.run.steps.length === 2)
    t.ok('the crash fired', crashed)
    t.eq('the runtime DID run that turn', await startedFor(f, 'implement'), 1)

    const resumed = await reopen(f, runId)
    t.eq('but the engine never recorded it', resumed.run.steps.filter((s) => s.stepId === 'implement').length, 0)
    const pendingRole = Object.values(resumed.run.participants).find((p) => p.pendingInvocation)?.role
    t.ok('the invocation is marked pending, so it is known to be uncertain', Boolean(pendingRole))

    await resumed.recover()
    const adopted = resumed.run.steps.find((s) => s.stepId === 'implement')
    t.ok('recovery adopted the completed work', Boolean(adopted))
    t.eq('without re-invoking the agent', await startedFor(f, 'implement'), 1)
    const outputs = await readOutputs(f.issuePath, runId)
    t.eq('and marked it adopted rather than freshly produced', outputs[adopted.number].adopted, true)

    const run = await resumed.drive()
    t.eq('still exactly one invocation for that step', await startedFor(f, 'implement'), 1)
    t.eq('no duplicate step', run.steps.filter((s) => s.stepId === 'implement').length, 1)
    t.eq('and the run completes', run.outcome, 'resolved')
    await releaseWorkspace(resumed)
  }

  // ------------------------------------------------------------ crash: after persist
  t.section('crash AFTER persistence but BEFORE advancing: position is re-derived')
  {
    const f = await engineFixture()
    const { crashed, runId } = await crashAt(f, 'afterPersistBeforeAdvance', (e) => e.run.steps.length === 3)
    t.ok('the crash fired', crashed)

    const resumed = await reopen(f, runId)
    t.eq('the step was already recorded', resumed.run.steps.length, 3)
    t.ok('no invocation is pending', Object.values(resumed.run.participants).every((p) => !p.pendingInvocation))

    await resumed.recover()
    const run = await resumed.drive()
    const ids = run.steps.map((s) => s.stepId)
    t.eq('no step was repeated', new Set(ids.map((id, i) => `${id}#${ids.slice(0, i).filter((x) => x === id).length}`)).size, ids.length)
    t.eq('each turn ran once at the runtime', await startedFor(f, 'implement'), 1)
    t.eq('and the run completes', run.outcome, 'resolved')
    await releaseWorkspace(resumed)
  }

  // ------------------------------------------------------------ no evidence
  t.section('missing recovery evidence: refuse to guess')
  {
    // A runtime whose ledger cannot be tied back to the invocation.
    const f = await engineFixture({ loseMarker: true })
    const { crashed, runId } = await crashAt(f, 'afterInvokeBeforePersist', (e) => e.run.steps.length === 2)
    t.ok('the crash fired', crashed)
    t.ok('the runtime did do work', (await f.fake.ledger.entries()).length > 0)

    const resumed = await reopen(f, runId)
    await resumed.recover()

    const role = Object.values(resumed.run.participants).find((p) => p.state === 'recovery-required')?.role
    t.ok('the participant is marked recovery-required', Boolean(role), role)
    t.eq('the run is blocked', resumed.run.status, 'blocked')
    t.eq('with the reason recorded', resumed.run.blockedReason, 'recovery-required')
    t.ok('and the reason names the invocation', /uncertain/.test(resumed.run.recovery.reason ?? ''), resumed.run.recovery.reason)
    t.eq('it did NOT silently retry', await startedFor(f, 'implement'), 1)
    t.eq('and it did NOT adopt work it could not attribute',
      resumed.run.steps.filter((s) => s.stepId === 'implement').length, 0)
    await releaseWorkspace(resumed)
  }

  await cleanupFixtures()
}
