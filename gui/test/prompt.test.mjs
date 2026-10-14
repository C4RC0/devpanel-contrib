import fs from 'node:fs/promises'
import path from 'node:path'

import { startRun, resumeRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { simulateProcessDeath } from './fakes/fixture.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { previewRun } from '../server/runtime/preview.mjs'
import { supportedActions } from '../server/supervisor.mjs'
import { engineFixture, cleanupFixtures } from './fakes/fixture.mjs'

export const name = 'prompt — one seat, one model, every input, no coordination'

const NL = String.fromCharCode(10)
const start = (f, extra = {}) => startRun({ ...f, issue: { project: 'devpanel-project', id: f.issue.id }, deliveryProvider: f.delivery, ...extra })

export default async function (t) {
  try {
    t.section('1. the playbook resolves to a single occupied seat and previews without a coordinator')
    let f = await engineFixture({ playbook: 'prompt' })
    const r = await resolvePlaybook('prompt', { root: f.configRoot })
    t.ok('resolves', r.ok, JSON.stringify(r.errors))
    // The absence of a coordinator is the design, not an omission: the
    // company-wide invariant is that a coordinator seat is coordination-only,
    // never that every playbook has one. Stated here so a future reading of
    // coordination.test.mjs cannot mistake this shape for a gap.
    t.eq('one seat', Object.keys(r.resolved.participants), ['worker'])
    t.eq('and deliberately no coordinator to disable', r.resolved.participants.coordinator ?? null, null)
    t.ok('so nothing in it is coordination-only', Object.values(r.resolved.participants).every((p) => !p.coordinationOnly))
    t.eq('it writes code', r.resolved.participants.worker.writesCode, true)
    t.eq('the tactic is prompt', r.resolved.tactic, 'prompt')
    t.eq('one phase, one step', r.resolved.phases.map((p) => p.step?.id ?? p.loop?.steps.map((s) => s.id)), ['execute'])
    t.eq('closure asks what one seat can give, and the seat\'s own word', r.resolved.completion.requires, ['checksSatisfied', 'noOutstandingBlockingFindings', 'workerCompletion', 'deliveryCompleted'])
    t.eq('delivery is a patch', r.resolved.completion.delivery.action, 'worktree-diff')
    t.eq('review-only, with the justification on record', r.resolved.autoClose.minimumVerification, 'review-only')
    const preview = await previewRun({ playbookId: 'prompt', configRoot: f.configRoot, deliveryActions: ['worktree-diff'] })
    t.ok('previews', preview.ok, JSON.stringify(preview.errors))
    t.ok('in place is accepted too', (await resolvePlaybook('prompt', { root: f.configRoot, runOptions: { isolation: 'in-place' } })).ok)

    t.section('2. the worker gets the issue and every input file, does the work, and the run closes on delivery')
    const task = await f.stepStore.create({ name: 'task', text: 'Change the greeting in source.txt to "hello from the prompt playbook".' })
    const issueDirs = await fs.readdir(f.issuePath)
    const taskFolder = path.join(f.issuePath, issueDirs.find((d) => /^\d{3}-task$/.test(d)))
    await fs.writeFile(path.join(taskFolder, 'spec.txt'), 'Exact wording: hello from the prompt playbook' + NL)
    const prompts = []
    const original = f.fake.invoke
    f.fake.invoke = async (args) => {
      prompts.push(args)
      if (args.meta.stepId === 'execute') await fs.writeFile(path.join(args.cwd, 'source.txt'), 'hello from the prompt playbook' + NL)
      return original(args)
    }
    let engine = await start(f)
    await engine.drive()
    t.eq('completed', engine.run.status, 'completed')
    t.eq('resolved', engine.run.outcome, 'resolved')
    t.eq('exactly one agent turn', prompts.map((p) => `${p.meta.role}/${p.meta.stepId}`), ['worker/execute'])
    t.eq('one recorded step', engine.run.steps.filter((s) => s.role !== 'operator').length, 1)
    const prompt = prompts[0].prompt
    t.ok('the tactic is named', /Tactic: prompt/.test(prompt))
    t.ok('the issue text is in the prompt as a captured-input excerpt', /"excerpts"/.test(prompt) && /hello from the prompt playbook/.test(prompt))
    t.ok('and the attachment excerpt too', /Exact wording/.test(prompt))
    t.ok('the window manifest is named, so every attached file is reachable', /window\.json/.test(prompt))
    t.ok('the seat writes code', prompts[0].tooling?.writesCode === true)
    const manifest = JSON.parse(await fs.readFile(engine.run.currentWindow.manifest, 'utf8'))
    const inputFiles = (manifest.inputs ?? []).map((i) => path.basename(i.file))
    t.ok('the note and the attachment were captured as inputs', inputFiles.includes('spec.txt') && inputFiles.some((n) => /^note\./.test(n)), inputFiles.join(','))
    t.eq('the candidate is fingerprinted', engine.run.revisions.length, 1)
    t.eq('and delivered as a patch', engine.run.delivery.action, 'worktree-diff')
    t.ok('with delivery completed', Boolean(engine.run.delivery.completedAt))
    t.ok('the required closure conditions hold', ['checksSatisfied', 'noOutstandingBlockingFindings', 'workerCompletion', 'deliveryCompleted'].every((c) => engine.run.closure.conditions[c] === true), JSON.stringify(engine.run.closure.conditions))
    t.eq('the seat\'s completion is on the closure record', engine.run.closure.workerCompleted, true)
    t.ok('and a confirmation nobody could give was not required', engine.run.closure.conditions.coordinatorConfirmation === false && engine.run.status === 'completed')
    t.eq('review-only, no independent audit', `${engine.run.closure.verificationLevel}/${engine.run.closure.independentAudit}`, 'review-only/false')
    t.eq('only a fresh start is offered afterwards', supportedActions(engine.run), ['start-new'])
    void task
    await releaseWorkspace(engine)

    t.section('3. a worker that cannot produce the contract is repaired once, then the run blocks rather than pretends')
    f = await engineFixture({ playbook: 'prompt' })
    const orig = f.fake.invoke
    f.fake.invoke = async (args) => {
      if (args.meta.stepId === 'execute') {
        await fs.writeFile(path.join(args.cwd, 'source.txt'), 'changed anyway' + NL)
        return { ...(await orig(args)), response: 'I did things but forgot the contract.' }
      }
      return orig(args)
    }
    engine = await start(f)
    await engine.drive()
    t.eq('blocked', engine.run.status, 'blocked')
    t.eq('by protocol repair', engine.run.blockedReason, 'protocol-repair-exhausted')
    t.eq('after one repair', engine.run.steps.filter((s) => s.stepId === 'execute').length, 2)
    t.eq('nothing delivered', f.delivery.calls.length, 0)
    await releaseWorkspace(engine)

    t.section('4. a seat that says the task is not done blocks the run; nothing is delivered or resolved')
    f = await engineFixture({ playbook: 'prompt' })
    const base = f.fake.invoke
    f.fake.invoke = async (args) => {
      const turn = await base(args)
      if (args.meta.stepId !== 'execute') return turn
      return { ...turn, response: `Stopped.${NL}\`\`\`json${NL}${JSON.stringify({ summary: 'The task is not completed: the operator must provide the missing requirements.', completed: false, blockers: [{ description: 'the note names a file that does not exist', needs: 'missing-information' }], basedOnRevision: null })}${NL}\`\`\`` }
    }
    engine = await start(f)
    await engine.drive()
    t.eq('blocked', engine.run.status, 'blocked')
    t.eq('as incomplete', engine.run.blockedReason, 'task-incomplete')
    t.eq('unresolved', engine.run.outcome, 'unresolved')
    t.eq('the blocker is on the closure record', engine.run.closure.blockers?.map((b) => b.needs), ['missing-information'])
    t.eq('nothing delivered', f.delivery.calls.length, 0)
    t.eq('the empty patch was never even written', engine.run.delivery, null)
    await releaseWorkspace(engine)

    t.section('5. completed: false without blockers is a contract violation, repaired once')
    f = await engineFixture({ playbook: 'prompt' })
    const plain = f.fake.invoke
    f.fake.invoke = async (args) => {
      const turn = await plain(args)
      if (args.meta.stepId !== 'execute' || args.meta.attempt > 1) return turn
      return { ...turn, response: `\`\`\`json${NL}${JSON.stringify({ summary: 'gave up', completed: false, basedOnRevision: null })}${NL}\`\`\`` }
    }
    engine = await start(f)
    await engine.drive()
    const attempts = engine.run.steps.filter((s) => s.stepId === 'execute')
    t.eq('two attempts', attempts.length, 2)
    t.eq('the first answer was a contract violation', engine.outputs[attempts[0].number]?.classification, 'contract-violation')
    t.ok('for the missing blockers', /blockers/.test(engine.outputs[attempts[0].number]?.error ?? ''), engine.outputs[attempts[0].number]?.error)
    t.eq('the repaired answer completed the run', engine.run.status, 'completed')
    await releaseWorkspace(engine)

    t.section('6. a failed check blocks closure even though nobody reviews the work')
    f = await engineFixture({ playbook: 'prompt' })
    engine = await start(f)
    engine.maybeRunChecks = async function () {
      const revision = this.run.revisions.at(-1)?.fingerprint
      if (revision && !this.run.checkResults.some((c) => c.revision === revision)) this.run.checkResults.push({ revision, result: 'failed', requirement: 'optional', at: this.clock.iso() })
    }
    await engine.drive()
    t.eq('blocked', engine.run.status, 'blocked')
    t.eq('because the check failed', engine.run.closure?.conditions?.checksSatisfied, false)
    t.eq('with the generic reason', engine.run.blockedReason, 'closure-conditions-unmet')
    t.eq('nothing delivered', f.delivery.calls.length, 0)
    await releaseWorkspace(engine)

    t.section('7. the seat\'s completion describes the revision its turn produced, not whatever the worktree holds later')
    const unverifiable = { calls: [], async deliver (args) { unverifiable.calls.push(args); await fs.writeFile(path.join(args.runDir, 'artifacts', 'delivered.patch'), 'x'); return { artifactRef: 'artifacts/delivered.patch', bytes: 1, reconstruction: { verified: false, fingerprint: 'sha256:0', expected: args.revision, detail: 'simulated' } } } }
    const resume = (g, runId) => resumeRun({ issuePath: g.issuePath, runId, harnesses: g.harnesses, stepStore: g.stepStore, clock: g.clock, configRoot: g.configRoot, projectPath: g.projectPath, deliveryProvider: g.delivery })
    for (const moved of [false, true]) {
      const g = await engineFixture({ playbook: 'prompt' })
      const ok = g.fake.invoke
      g.fake.invoke = async (args) => { if (args.meta.stepId === 'execute') await fs.writeFile(path.join(args.cwd, 'source.txt'), 'done' + NL); return ok(args) }
      const run = await start(g, { deliveryProvider: unverifiable })
      await run.drive()
      t.eq(`${moved}: blocked at delivery first`, run.run.blockedReason, 'delivery-unverifiable')
      if (moved) await fs.writeFile(path.join(run.run.workspace.path, 'source.txt'), 'changed after the seat reported' + NL)
      await simulateProcessDeath(g.issuePath)
      const again = await resume(g, run.runId)
      await again.finalize()
      if (moved) {
        t.eq('a moved candidate is not what the seat completed', again.run.blockedReason, 'candidate-changed-since-approval')
        t.eq('the completion no longer holds', again.run.closure.conditions.workerCompletion, false)
        t.eq('drift recorded', again.run.closure.drifted, true)
        t.eq('nothing delivered', g.delivery.calls.length, 0)
      } else {
        t.eq('an unchanged candidate finalizes', again.run.status, 'completed')
        t.eq('on the seat\'s completion', again.run.closure.conditions.workerCompletion, true)
      }
      await releaseWorkspace(again)
    }
  } finally {
    await cleanupFixtures()
  }
}
