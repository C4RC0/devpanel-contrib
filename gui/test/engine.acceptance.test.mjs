import fs from 'node:fs/promises'
import path from 'node:path'

import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { engineFixture, scriptFor, blocking, cosmetic, cleanupFixtures } from './fakes/fixture.mjs'

export const name = 'engine — launch gating, loops, cancellation, snapshots, approvals, storage'

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

const idsOf = (run) => run.steps.map((s) => s.stepId)
const countOf = (run, stepId) => run.steps.filter((s) => s.stepId === stepId).length

export default async function (t) {
  // ---------------------------------------------------------------- gating
  t.section('launch gating: a rejected preflight produces zero invocations')
  {
    const f = await engineFixture()
    // A probe with no credentials: installed, but nothing proven.
    const unauth = async (_h, opts) => ({ ...await f.fake.probe(opts), authentication: { status: 'missing', detail: 'no credentials' } })
    let threw = null
    try { await start(f, { probe: unauth }) } catch (e) { threw = e }
    t.ok('startRun refuses', Boolean(threw), threw?.message?.split(String.fromCharCode(10))[0])
    t.eq('the harness was never invoked', await f.fake.ledger.invocationCount(), 0)
    t.eq('no step folders were created', (await f.stepFolders()).length, 0)

    // The refusal is kept, not erased. Probing at model depth costs a call per
    // model, so a run that spent and then refused has to say so.
    const dirs = await fs.readdir(path.join(f.issuePath, 'runs')).catch(() => [])
    const runIds = dirs.filter((d) => !d.startsWith('worktree-') && !d.startsWith('workspace-'))
    t.eq('the refused attempt is recorded as a run', runIds.length, 1)

    const recorded = JSON.parse(await fs.readFile(path.join(f.issuePath, 'runs', runIds[0], 'run.json'), 'utf8'))
    t.eq('marked failed', recorded.status, 'failed')
    t.eq('with the reason', recorded.blockedReason, 'preflight-refused')
    t.eq('preflight is recorded as refused', recorded.preflight.state, 'refused')
    t.eq('no workspace was ever created', recorded.workspace.state, 'pending')

    // And the issue is free again — a refusal must not hold the lock.
    const lockGone = await fs.access(path.join(f.issuePath, '.run.lock')).then(() => false, () => true)
    t.ok('the run lock was released', lockGone)
  }

  t.section('reference playbook: agreement ends with a persisted coordinator closing report')
  {
    const script = scriptFor()
    let closingPrompt = null
    const report = '# Closing report\nThe candidate meets AC1. Checks were not run; review-only.\n'
    const f = await engineFixture({ script: (turn) => {
      if (turn.stepId === 'confirm') {
        closingPrompt = turn.prompt
        return report + script(turn)
      }
      return script(turn)
    } })
    const engine = await start(f)
    const run = await engine.drive()
    t.eq('agreement completes the reference playbook', run.status, 'completed')
    t.eq('issue outcome is resolved', run.outcome, 'resolved')
    t.eq('does not claim test verification', run.closure.verificationLevel, 'review-only')
    t.eq('coordinator writes the last turn', run.steps.at(-1).role, 'coordinator')
    t.eq('last turn is the closing report', run.steps.at(-1).stepId, 'confirm')
    // The coordinator's closing turn reconciles recorded evidence per criterion;
    // it neither writes a narrative report nor claims verification it did not do.
    t.ok('closing prompt requires evidence per criterion', closingPrompt.includes('Cite the reporting seat/step and the recorded evidence for each met criterion'))
    // The final audit reaches the coordinator as the auditor seat's structured report.
    t.ok('closing prompt includes the final audit', /"role": "auditor-1"[\s\S]*"verdict": "approved"/.test(closingPrompt))
    t.ok('closing prompt requires residual risks and forbids claimed testing', closingPrompt.includes('material residualRisks') && closingPrompt.includes('Do not claim personal testing'))
    const folders = await f.stepFolders()
    const last = folders.find((folder) => folder.endsWith('-confirm'))
    const response = await fs.readFile(path.join(f.issuePath, last, 'response.md'), 'utf8')
    t.ok('report is preserved as the visible step response', response.startsWith(report))
    await releaseWorkspace(engine)
  }

  // ---------------------------------------------------------------- loops
  t.section('loops: a revision returns to the auditor')
  {
    const f = await engineFixture({
      script: scriptFor({ implReviews: [[blocking('F1')], []] })
    })
    const engine = await start(f)
    const run = await engine.drive()
    // The implementation loop has no separate fix step: the next round's
    // implement turn is the correction.
    t.eq('the implementer ran once more', countOf(run, 'implement'), 2)
    t.eq('the auditor looked twice', countOf(run, 'audit-implement-1'), 2)
    const seq = idsOf(run).filter((s) => s === 'audit-implement-1' || s === 'implement').join(' ')
    t.eq('order is implement, audit, implement, audit', seq, 'implement audit-implement-1 implement audit-implement-1')
    t.eq('and it closed', run.outcome, 'resolved')
    await releaseWorkspace(engine)
  }

  t.section('loops: a non-substantial finding does not send the author back')
  {
    const f = await engineFixture({ script: scriptFor({ implReviews: [[cosmetic('F9')]] }) })
    const engine = await start(f)
    const run = await engine.drive()
    t.eq('no correction round', countOf(run, 'implement'), 1)
    t.eq('one audit', countOf(run, 'audit-implement-1'), 1)
    t.eq('it closed', run.outcome, 'resolved')
    t.eq('the cosmetic finding is not outstanding', run.outstandingFindings.length, 0)
    await releaseWorkspace(engine)
  }

  t.section('loops: malformed output repairs with the SAME participant')
  {
    const f = await engineFixture({
      script: scriptFor({ malformed: new Set(['audit-implement-1@1']) })
    })
    const engine = await start(f)
    const run = await engine.drive()
    const attempts = run.steps.filter((s) => s.stepId === 'audit-implement-1')
    t.eq('two attempts recorded', attempts.length, 2)
    t.eq('attempt numbers', attempts.map((a) => a.attempt), [1, 2])
    t.eq('same participant both times', new Set(attempts.map((a) => a.role)).size, 1)
    t.eq('same round — repair is not a new review round', new Set(attempts.map((a) => a.round)).size, 1)
    t.eq('the implementer was NOT sent to correct anything', countOf(run, 'implement'), 1)
    t.eq('and the run still closes', run.outcome, 'resolved')
    await releaseWorkspace(engine)
  }

  t.section('loops: exhausted protocol repair blocks rather than proceeding')
  {
    const f = await engineFixture({
      script: scriptFor({ malformed: new Set(['audit-implement-1@1', 'audit-implement-1@2', 'audit-implement-1@3']) })
    })
    const engine = await start(f)
    const run = await engine.drive()
    t.eq('status', run.status, 'blocked')
    t.eq('reason', run.blockedReason, 'protocol-repair-exhausted')
    t.eq('issue left unresolved', run.outcome, 'unresolved')
    await releaseWorkspace(engine)
  }

  t.section('loops: exhausted rounds leave the issue unresolved')
  {
    // The playbook caps implement-review at 2 rounds; this auditor never approves.
    // The findings do not shrink, so exhaustion ends the run unresolved without asking.
    const f = await engineFixture({
      script: scriptFor({ implReviews: [[blocking('F1')], [blocking('F1')], [blocking('F1')]] })
    })
    const playbookFile = path.join(f.configRoot, 'playbooks/implementation.yaml')
    await fs.writeFile(playbookFile, (await fs.readFile(playbookFile, 'utf8')).replace('budgets:\n', 'overrides:\n  implement-review.maxRounds: 2\nbudgets:\n'))
    const engine = await start(f)
    const run = await engine.drive()
    t.eq('nobody was asked', run.steps.filter((s) => s.role === 'operator').length, 0)
    t.eq('outcome', run.outcome, 'unresolved')
    t.eq('status', run.status, 'blocked')
    t.eq('reason names round exhaustion', run.blockedReason, 'rounds-exhausted')
    t.eq('rounds respected the cap', countOf(run, 'audit-implement-1'), 2)
    t.eq('no closure record', run.closure, null)
    await releaseWorkspace(engine)
  }

  t.section('loops: a verdict contradicting its own findings is a protocol failure')
  {
    // An auditor that approves while raising a blocking finding, and never restates.
    const f = await engineFixture({
      script: (args) => args.stepId === 'audit-implement-1'
        ? `Contradictory.${String.fromCharCode(10)}\`\`\`json${String.fromCharCode(10)}{"verdict":"approved","artifactRevision":"x","findings":[{"id":"F1","severity":"major","blocking":true,"description":"broken"}]}${String.fromCharCode(10)}\`\`\`${String.fromCharCode(10)}`
        : scriptFor()(args)
    })
    const engine = await start(f)
    const run = await engine.drive()
    const attempts = run.steps.filter((s) => s.stepId === 'audit-implement-1')
    t.ok('repair was attempted', attempts.length > 1, `${attempts.length} attempts`)
    t.eq('the implementer was never sent to fix a contradiction', countOf(run, 'implement'), 1)
    t.eq('and it blocks rather than closing on a contradiction', run.blockedReason, 'protocol-repair-exhausted')
    await releaseWorkspace(engine)
  }

  t.section('loops: an unfit triage aborts before any work')
  {
    const f = await engineFixture({ script: scriptFor({ fitVerdict: false }) })
    const engine = await start(f)
    const run = await engine.drive()
    t.eq('only triage ran', idsOf(run), ['triage'])
    t.eq('outcome', run.outcome, 'unresolved')
    await releaseWorkspace(engine)
  }

  // ---------------------------------------------------------------- cancel
  t.section('cancellation stops the invocation before ownership is released')
  {
    const f = await engineFixture()
    const engine = await start(f)
    let cancelledAt = null
    engine.hooks.beforeInvoke = async (e) => {
      if (e.run.steps.length === 2) { cancelledAt = e.clock.now(); e.cancel() }
    }
    const run = await engine.drive()
    t.eq('run cancelled', run.status, 'cancelled')
    t.ok('subsequent turns were prevented', run.steps.length === 2, `${run.steps.length} steps`)
    t.ok('the active invocation actually stopped', engine.invocationStoppedAt !== null)
    t.ok('no participant is left mid-invocation',
      Object.values(run.participants).every((p) => p.pendingInvocation === null))

    await releaseWorkspace(engine)
    t.ok('workspace released only after the invocation stopped',
      engine.workspaceReleasedAt >= engine.invocationStoppedAt,
      `stopped=${engine.invocationStoppedAt} released=${engine.workspaceReleasedAt}`)
    t.eq('workspace marked removed', engine.run.workspace.state, 'removed')

    // Driving again must not resume a cancelled run.
    const before = engine.run.steps.length
    await engine.drive()
    t.eq('a cancelled run does not restart on drive', engine.run.steps.length, before)
  }

  // ---------------------------------------------------------------- snapshot
  t.section('snapshots: editing sources after start cannot change later turns')
  {
    const seen = []
    const base = scriptFor()
    const f = await engineFixture({
      script: (args) => { seen.push({ stepId: args.stepId, prompt: args.prompt }); return base(args) }
    })
    const engine = await start(f)
    await engine.drive({ maxTurns: 1 })          // triage only

    // Now vandalise the sources this run was started from.
    const promptFile = path.join(f.configRoot, 'strategy-templates/implementation/prompts/brief.md')
    await fs.writeFile(promptFile, 'MUTATED TEMPLATE — must never be rendered')
    const playbookFile = path.join(f.configRoot, 'playbooks/implementation.yaml')
    await fs.writeFile(playbookFile, 'id: implementation' + String.fromCharCode(10) + 'MUTATED')

    const run = await engine.drive()
    const brief = seen.find((s) => s.stepId === 'brief-implement')
    t.ok('the later turn ran', Boolean(brief))
    t.ok('it did not render the mutated template', !brief.prompt.includes('MUTATED'))
    t.ok('it rendered the snapshotted body', brief.prompt.includes('Give implementer a concise assignment'))
    t.eq('the run still completes under its original configuration', run.outcome, 'resolved')

    const snapshot = JSON.parse(await fs.readFile(path.join(f.issuePath, 'runs', engine.runId, 'resolved-playbook.json'), 'utf8'))
    t.ok('the snapshot embeds prompt bytes, not just a path',
      typeof snapshot.prompts['brief.md'].body === 'string' && snapshot.prompts['brief.md'].body.length > 100)
    t.ok('and keeps the hash to prove what it snapshotted',
      /^sha256:/.test(snapshot.prompts['brief.md'].hash))
    await releaseWorkspace(engine)
  }

  // ---------------------------------------------------------------- approvals
  t.section('approval integrity: changed content invalidates approvals and checks')
  {
    const f = await engineFixture()
    const engine = await start(f)
    const run = await engine.drive()
    t.eq('closed with an approval', run.approvals.length, 1)
    const approvedRevision = run.approvals[0].revision
    t.eq('the approval names the delivered revision', approvedRevision, run.revisions.at(-1).fingerprint)

    // A check result taken against that same revision.
    engine.run.checkResults.push({ revision: approvedRevision, result: 'passed', target: 'fake', commands: [], at: engine.clock.iso() })

    // The author touches the candidate again.
    await fs.writeFile(path.join(engine.run.workspace.path, 'late-change.txt'), 'after approval')
    const fp = await engine.recordRevision(run.steps.at(-1).number)

    t.ok('the fingerprint moved', fp.fingerprint !== approvedRevision)
    t.eq('the approval is gone', engine.run.approvals.length, 0)
    t.eq('the check result is gone', engine.run.checkResults.length, 0)

    await engine.evaluateClosure()
    t.eq('closure no longer has same-revision approval', engine.run.closure.conditions.sameRevisionApproval, false)
    t.ok('and the run is no longer closeable', engine.run.outcome !== 'resolved', engine.run.outcome)
    await releaseWorkspace(engine)
  }

  // ---------------------------------------------------------------- storage
  t.section('storage: concurrent creation, repeated slugs, response-only folders')
  {
    const f = await engineFixture()
    const names = ['audit plan', 'fix', 'audit plan', 'fix', 'audit plan', 'verify', 'fix', 'audit plan']
    await Promise.all(names.map((n) => f.stepStore.create({ name: n, response: `# ${n}` })))
    const steps = await f.issues.listSteps('devpanel-project', f.issue.id)
    const numbers = steps.map((s) => s.number)
    t.eq('every number is unique', new Set(numbers).size, numbers.length)
    t.eq('numbers are contiguous from 000', numbers.join(','), numbers.map((_, i) => String(i).padStart(3, '0')).join(','))
    t.eq('a slug may repeat', steps.filter((s) => s.slug === 'audit-plan').length, 4)
    for (const s of steps.slice(0, 3)) {
      t.eq(`${s.id} holds only response.md`, await f.filesIn(s.id), ['response.md'])
    }
  }

  await cleanupFixtures()
}
