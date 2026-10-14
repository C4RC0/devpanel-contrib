import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { engineFixture, scriptFor } from './fakes/fixture.mjs'

export const name = 'timing — how long each turn actually took'

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
  deliveryProvider: f.delivery,
  ...extra
})

/** Every turn takes `ms` on the injected clock, whatever the machine is doing. */
const paced = (ms, options = {}) => {
  const base = scriptFor(options)
  return (meta) => ({ text: base(meta), delayTicks: ms })
}

export default async function (t) {
  // ------------------------------------------------------------- measurement
  t.section('1. every turn is timestamped and measured')
  {
    const f = await engineFixture({ script: paced(1500) })
    const engine = await start(f)
    const run = await engine.drive()

    t.ok('the run produced turns', run.steps.length > 0, `${run.steps.length} steps`)
    t.ok('every turn has a start', run.steps.every((s) => Boolean(s.startedAt)))
    t.ok('and an end', run.steps.every((s) => Boolean(s.endedAt)))
    t.ok('each one measured at what it took', run.steps.every((s) => s.durationMs === 1500),
      [...new Set(run.steps.map((s) => s.durationMs))].join(', '))
    t.ok('and ends after it starts',
      run.steps.every((s) => Date.parse(s.endedAt) >= Date.parse(s.startedAt)))

    const summed = run.steps.reduce((n, s) => n + s.durationMs, 0)
    t.eq('the run total is the sum of its turns', run.timing.agentMs, summed)
    t.eq('nothing went unmeasured', run.timing.unknownSteps, 0)
    t.eq('and nothing was abandoned', run.timing.abandonedMs, 0)

    await releaseWorkspace(engine)
  }

  // --------------------------------------------- what counts as agent time
  t.section('2. the measurement stops when the agent answers, not when we finish filing it')
  {
    // Persisting a turn writes a folder, extracts structured output and
    // fingerprints the workspace. That is devpanel's time. Charging it to the
    // model would make every turn look slower than it was, and the error would
    // grow with the size of the project rather than with the work done.
    const f = await engineFixture({ script: paced(1000) })
    const engine = await start(f, {
      hooks: {
        afterInvokeBeforePersist: () => { f.clock.advance(9000) },
        afterPersistBeforeAdvance: () => { f.clock.advance(9000) }
      }
    })
    const run = await engine.drive()

    t.ok('turns still measure only the invocation', run.steps.every((s) => s.durationMs === 1000),
      [...new Set(run.steps.map((s) => s.durationMs))].join(', '))

    // The wall clock has to be much larger, or the hooks did nothing and the
    // assertion above proved nothing.
    const wall = Date.parse(run.endedAt) - Date.parse(run.startedAt)
    t.ok('while the run itself took far longer', wall > run.timing.agentMs * 5,
      `wall ${wall}ms vs agents ${run.timing.agentMs}ms`)

    await releaseWorkspace(engine)
  }

  // ------------------------------------------------------ abandoned turns
  t.section('3. a turn that was abandoned still spent the time it spent')
  {
    // One turn hangs past the wall-clock budget (implementation allows 240 minutes) and is aborted mid-flight. It
    // produces no step — there is no response to file — but it is exactly the
    // case where knowing how long was wasted matters most.
    const base = scriptFor()
    const hangs = (meta) => ({
      text: base(meta),
      delayTicks: meta.stepId === 'implement' ? 241 * 60 * 1000 : 1000
    })

    const f = await engineFixture({ script: hangs })
    const engine = await start(f)
    const run = await engine.drive()

    t.eq('the run stopped on its budget', run.status, 'blocked')
    t.eq('naming the budget', run.blockedReason, 'budget-exhausted')

    const finished = run.steps.length
    t.ok('the turns that answered are measured', run.steps.every((s) => s.durationMs === 1000),
      [...new Set(run.steps.map((s) => s.durationMs))].join(', '))
    t.eq('and counted', run.timing.agentMs, finished * 1000)

    // The hung turn left no step, so this is the only place its cost is visible.
    t.ok('the abandoned turn is accounted for, not dropped',
      run.timing.abandonedMs > 240 * 60 * 1000, `${run.timing.abandonedMs}ms`)
    t.ok('separately from the turns that produced something',
      run.timing.abandonedMs !== run.timing.agentMs)
    t.eq('and it produced no step', run.steps.some((s) => s.stepId === 'implement'), false)

    await releaseWorkspace(engine)
  }

  // ----------------------------------------------- unknown is not zero
  t.section('4. work adopted after a restart is unmeasured, not instant')
  {
    const f = await engineFixture({ script: paced(800) })
    const engine = await start(f)

    // A turn the runtime completed but whose duration nothing recorded: the
    // engine died between the answer and the filing, so there is no answer time
    // to read back. The honest value is "unknown".
    const role = 'coordinator'
    const pending = {
      invocationId: 'adopted-invocation',
      startedAt: engine.clock.iso(),
      marker: `devpanel:${engine.runId}:adopted-invocation`,
      stepNumber: null,
      cursor: { phase: 'triage', stepId: 'triage', round: 0, attempt: 1, contract: null, recordsRevision: false }
    }
    await engine.commitTurn({ role, pending, response: 'recovered text', session: { id: 's1' }, adopted: true })

    const step = engine.run.steps.find((s) => s.invocationId === 'adopted-invocation')
    t.ok('the step exists', Boolean(step))
    t.eq('with no end time', step.endedAt, null)
    t.eq('and no duration', step.durationMs, null)
    t.ok('it says why rather than showing a zero', /adopted|recorded/i.test(step.durationUnknown ?? ''),
      step.durationUnknown)
    t.eq('the run counts it as unmeasured', engine.run.timing.unknownSteps, 1)
    t.eq('and it adds nothing to the agent total', engine.run.timing.agentMs, 0)

    await releaseWorkspace(engine)
  }
}
