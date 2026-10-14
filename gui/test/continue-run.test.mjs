import fs from 'node:fs/promises'
import path from 'node:path'
import { engineFixture, scriptFor } from './fakes/fixture.mjs'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { supportedActions } from '../server/supervisor.mjs'
import { continueUnavailable } from '../server/runtime/run-control.mjs'

const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```'
const revision = (p) => (p.match(/Current revision: (sha256:[a-f0-9]{64})/) ?? [])[1] ?? null

/*
 * A run whose coordinator refuses closure the first time (a test drive that
 * crashed, say), then is continued by the operator: the author gets one more
 * round in the same run, and the run closes on the next confirmation.
 */
async function scenario () {
  const prompts = []
  let engine = null
  let confirms = 0
  const script = async (turn) => {
    const { stepId, role, round, prompt } = turn
    prompts.push({ stepId, role, round, prompt })
    if (stepId.startsWith('brief')) return fence({ targetRole: 'worker', prompt: 'Do the work.', windowDecision: 'keep' })
    if (stepId === 'implement') {
      await fs.writeFile(path.join(engine.run.workspace.path, `round-${round}.txt`), 'work\n')
      return fence({ summary: `Implemented round ${round}`, basedOnRevision: revision(prompt) })
    }
    if (stepId.startsWith('audit-')) return fence({ verdict: 'approved', artifactRevision: revision(prompt), findings: [], priorFindings: [] })
    if (stepId === 'confirm') {
      confirms++
      // A matter for the operator (owner-gate), so the engine does not return
      // it to the author itself: the run stops and Continue reopens it.
      return confirms === 1
        ? fence({ satisfied: false, criteria: [{ id: 'AC1', met: false, unmet: 'owner-gate', evidence: 'the test drive did not boot' }], revision: revision(prompt) })
        : fence({ satisfied: true, criteria: [{ id: 'AC1', met: true }], revision: revision(prompt) })
    }
    return scriptFor()(turn)
  }
  const f = await engineFixture({ playbook: 'implementation', script })
  const runOptions = { participants: { 'auditor-1': { model: 'gpt-6-astra' } } }
  const resolved = await resolvePlaybook('implementation', { root: f.configRoot, runOptions, projectId: 'devpanel-project' })
  if (!resolved.ok) throw new Error(resolved.errors.map((e) => e.message).join('; '))
  engine = await startRun({
    expectConfigHash: resolved.resolved.configHash, playbookId: 'implementation', issue: { ...f.issue, project: 'devpanel-project' },
    issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider,
    configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery, runOptions
  })
  await engine.drive()
  return { engine, f, prompts }
}

export default async function (t) {
  t.section('a run stopped at closure is continued: one more author round, then closure')
  {
    const { engine, f, prompts } = await scenario()
    t.eq('the first confirmation stops the run at closure', `${engine.run.status} ${engine.run.blockedReason}`, 'blocked closure-conditions-unmet', JSON.stringify(engine.run.closure?.conditions))
    t.eq('an operator matter is not returned to the author', [engine.run.closureReturns ?? [], engine.run.closure?.notReturned], [[], 'AC1: owner-gate'])
    t.ok('continue is offered beside refresh-checks', supportedActions(engine.run).includes('continue'), JSON.stringify(supportedActions(engine.run)))
    t.eq('resume is not: replaying the record would reach the same closure', supportedActions(engine.run).includes('resume'), false)

    const first = Number(engine.run.steps[0].number)
    const note = `${String(first + 40).padStart(3, '0')}-note`
    await fs.mkdir(path.join(f.issuePath, note))
    await fs.writeFile(path.join(f.issuePath, note, 'note.md'), '# Diagnosis\n\nThe boot fails in module.mjs:11.\n')

    t.eq('an unnamed actor is refused', await engine.continueRun({ text: 'x', actor: '' }).then(() => null, (e) => e.status), 400)
    const entry = await engine.continueRun({ text: 'Fix the boot crash first.', actor: 'tester' })
    t.eq('the note written since the run began is carried', entry.notes, [note])
    t.eq('the run is pending again', engine.run.status, 'pending')
    const decision = engine.run.steps.at(-1)
    t.eq('recorded as an operator decision step', `${decision.role} ${decision.decision?.key}`, 'operator implement-review:continue')
    t.ok('the decision carries the instruction, the closure record and the note', ['Fix the boot crash first.', 'closure-conditions-unmet', 'coordinatorConfirmation', 'module.mjs:11'].every((s) => decision.decision.answer.includes(s)), decision.decision.answer)

    await engine.drive()
    t.eq('the continued run completes', engine.run.status, 'completed', `${engine.run.blockedReason} ${JSON.stringify(engine.run.closure?.conditions)}`)
    t.eq('the author got exactly one more round', prompts.filter((p) => p.stepId === 'implement').map((p) => p.round), [0, 1])
    const brief1 = prompts.find((p) => p.stepId === 'brief-implement' && p.round === 1)
    t.ok('the next brief read the operator decision', brief1?.prompt.includes('Fix the boot crash first.') && brief1.prompt.includes('module.mjs:11'))
    t.eq('the first confirmation is superseded, a new one ran', prompts.filter((p) => p.stepId === 'confirm').length, 2)
    t.ok('the earlier confirmation is out of the active record', engine.run.supersededSteps?.length === 1)
    t.ok('a completed run cannot be continued', Boolean(continueUnavailable(engine.run)))
    t.eq('a second Continue would not carry the same note again', (await engine.notesSinceStart()).length, 0)
    await releaseWorkspace(engine)
  }
}
