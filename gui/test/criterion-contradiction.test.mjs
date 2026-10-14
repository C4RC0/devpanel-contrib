import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { engineFixture, scriptFor, cosmetic, cleanupFixtures } from './fakes/fixture.mjs'

export const name = 'engine — a finding against an acceptance criterion cannot accompany approval'

const NL = String.fromCharCode(10)
const fence = (obj) => ['```json', JSON.stringify(obj), '```'].join(NL)

const start = (f) => startRun({
  playbookId: f.playbookId,
  issue: { project: 'devpanel-project', id: f.issue.id, name: f.issue.name, openedOn: f.issue.openedOn, path: f.issuePath },
  issuePath: f.issuePath,
  projectPath: f.projectPath,
  harnesses: f.harnesses,
  stepStore: f.stepStore,
  workspaceProvider: f.workspaceProvider,
  configRoot: f.configRoot,
  probe: f.probe,
  clock: f.clock,
  deliveryProvider: f.delivery
})

/** Wrap a script so every prompt is captured by step id and attempt. */
const recording = (script) => {
  const seen = []
  return { seen, script: (turn) => { seen.push({ ...turn }); return script(turn) } }
}

const countOf = (run, stepId) => run.steps.filter((s) => s.stepId === stepId).length
const revisionIn = (prompt) => (prompt.match(/sha256:[0-9a-f]{64}/) ?? [null])[0]

// A documentation defect the fixture's triage criterion AC1 names: minor by
// severity, but it says the candidate does not meet the criterion.
const against = (criterion, blocking) => ({ id: 'auditor-1-doc', severity: 'minor', blocking, description: 'the doc contradicts the criterion', criterion, location: 'source.txt:1', contradicts: criterion })
const review = (turn, verdict, findings) => `Reviewed the code.${NL}${fence({ verdict, artifactRevision: revisionIn(turn.prompt), findings, priorFindings: [] })}`

/** Run the implementation playbook with the first audit round answered by `audit(turn)`. */
async function drive (audit, base = scriptFor()) {
  const { seen, script } = recording((turn) => turn.stepId === 'audit-implement-1' && turn.round === 0 ? audit(turn) : base(turn))
  const f = await engineFixture({ playbook: 'implementation', script })
  const engine = await start(f)
  const run = await engine.drive()
  return { engine, run, seen }
}

export default async function (t) {
  t.section('approved beside a finding that contradicts a criterion is repaired into changes-needed')
  {
    const { engine, run, seen } = await drive((turn) => turn.attempt === 1
      ? review(turn, 'approved', [against('AC1', false)])
      : review(turn, 'changes-needed', [against('AC1', true)]))
    const repair = seen.find((s) => s.stepId === 'audit-implement-1' && s.round === 0 && s.attempt === 2)
    t.ok('the auditor was asked to restate', Boolean(repair))
    t.ok('and told why', repair?.prompt.includes('contradicts acceptance criterion AC1') && repair.prompt.includes('blocking whatever its severity'),
      repair?.prompt.split(NL).find((l) => l.includes('AC1')))
    t.eq('the repaired changes-needed sent the author a round', countOf(run, 'implement'), 2)
    t.eq('and once the next audit approves, the run closes', run.outcome, 'resolved', run.blockedReason)
    await releaseWorkspace(engine)
  }

  t.section('an unrepaired contradiction contributes no approval')
  {
    const { engine, run } = await drive((turn) => review(turn, 'approved', [against('AC1', false)]))
    t.eq('exhausted repair blocks', run.blockedReason, 'protocol-repair-exhausted')
    t.eq('the author was never sent around by it', countOf(run, 'implement'), 1)
    t.ok('the run did not close', run.outcome !== 'resolved')
    await releaseWorkspace(engine)
  }

  t.section('approved beside a minor observation outside the criteria stands')
  {
    const { engine, run, seen } = await drive((turn) => review(turn, 'approved', [cosmetic('auditor-1-nit')]))
    t.eq('the auditor was not asked to restate', seen.filter((s) => s.stepId === 'audit-implement-1' && s.attempt > 1).length, 0)
    t.eq('the author was not sent around', countOf(run, 'implement'), 1)
    t.eq('the run closes', run.outcome, 'resolved', run.blockedReason)
    t.eq('with nothing outstanding', run.outstandingFindings.length, 0)
    await releaseWorkspace(engine)
  }

  t.section('a criterion the brief does not list is not the auditor\'s to invent')
  {
    const { engine, run, seen } = await drive((turn) => review(turn, 'approved', [against('AC9', false)]))
    const repair = seen.find((s) => s.stepId === 'audit-implement-1' && s.round === 0 && s.attempt === 2)
    t.ok('the auditor was asked to restate, naming the criteria it may cite', repair?.prompt.includes('"AC9"') && repair.prompt.includes('(AC1)'),
      repair?.prompt.split(NL).find((l) => l.includes('AC9')))
    t.eq('exhausted repair blocks', run.blockedReason, 'protocol-repair-exhausted')
    t.ok('the run did not close', run.outcome !== 'resolved')
    await releaseWorkspace(engine)
  }

  await cleanupFixtures()
}
