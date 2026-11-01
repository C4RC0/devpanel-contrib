import fs from 'node:fs/promises'
import path from 'node:path'
import { engineFixture, scriptFor } from './fakes/fixture.mjs'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { readEvents } from '../server/runtime/store.mjs'

const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```'
const revision = (p) => (p.match(/Current revision: (sha256:[a-f0-9]{64})/) ?? [])[1] ?? null
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function scenario ({ concurrent = true } = {}) {
  const log = []
  const prompts = []
  let engine = null
  const script = async (turn) => {
    const { stepId, role, round, prompt } = turn
    prompts.push({ stepId, role, round, prompt })
    if (stepId.startsWith('brief')) return fence({ targetRole: 'worker', prompt: 'Do the work.', windowDecision: 'keep' })
    if (stepId === 'implement') {
      await fs.writeFile(path.join(engine.run.workspace.path, round > 0 ? 'fixed.txt' : 'work.txt'), 'work\n')
      return fence({ summary: round ? 'Fixed the failing check' : 'Implemented', basedOnRevision: revision(prompt) })
    }
    if (stepId.startsWith('audit-')) {
      const entry = { role, round, from: Date.now(), checksRunning: Boolean(engine.checksInFlight) }
      log.push(entry)
      await sleep(150)
      entry.to = Date.now()
      return fence({ verdict: 'approved', artifactRevision: revision(prompt), findings: [], priorFindings: [] })
    }
    if (stepId === 'confirm') return fence({ satisfied: true, criteria: [{ id: 'AC1', met: true }], revision: revision(prompt) })
    return scriptFor()(turn)
  }
  const f = await engineFixture({ playbook: 'implementation', script })
  // A local check that takes a while and fails until the author writes fixed.txt.
  // The base (no work.txt) passes it, so the failure is the candidate's own.
  await fs.appendFile(path.join(f.configRoot, 'playbooks/implementation.yaml'),
    `\nchecks:\n  requirement: optional\n${concurrent ? '' : '  concurrent: false\n'}  target:\n    kind: local\n    commands:\n      - id: fixed\n        run: sleep 0.6; test -f fixed.txt || test ! -f work.txt\n`)
  const runOptions = { participants: { 'auditor-1': { model: 'gpt-6-astra' }, 'auditor-2': { model: 'gpt-6-astra' } } }
  const resolved = await resolvePlaybook('implementation', { root: f.configRoot, runOptions, projectId: 'devpanel-project' })
  if (!resolved.ok) throw new Error(resolved.errors.map((e) => e.message).join('; '))
  engine = await startRun({
    expectConfigHash: resolved.resolved.configHash, playbookId: 'implementation', issue: { ...f.issue, project: 'devpanel-project' },
    issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider,
    configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery, runOptions
  })
  await engine.drive()
  const { events } = await readEvents(f.issuePath, engine.runId)
  return { engine, f, log, prompts, events }
}

export default async function (t) {
  t.section('checks run beside the audits, and a failed check still sends the author round again')
  {
    const { engine, log, prompts, events } = await scenario()
    t.eq('the run completes', engine.run.status, 'completed', `${engine.run.blockedReason} ${JSON.stringify(engine.run.closure?.conditions)}`)
    t.eq('the reviewers approved round 0, but the failed check made a second implementation round', prompts.filter((p) => p.stepId === 'implement').length, 2)
    const started = events.filter((e) => e.type === 'checks-started').map((e) => Date.parse(e.at))
    const finished = events.filter((e) => e.type === 'checks').map((e) => Date.parse(e.at))
    const round0 = log.filter((e) => e.round === 0)
    t.ok('round 0 audits ran while its check was running', round0.length === 2 && round0.every((a) => a.checksRunning), JSON.stringify(round0))
    const audit0 = prompts.find((p) => p.stepId.startsWith('audit-') && p.round === 0)
    t.ok('reviewers were told the check is running and gates the round', audit0.prompt.includes('"result": "running"'))
    const brief1 = prompts.find((p) => p.stepId === 'brief-implement' && p.round === 1)
    t.ok('the next brief saw the failure', brief1?.prompt.includes('"result": "failed"'))
    const implement1 = prompts.find((p) => p.stepId === 'implement' && p.round === 1)
    t.ok('the author of the next round is told where the failed check\'s full logs are', implement1?.prompt.includes("The run's check logs are readable") && implement1.prompt.includes(path.join(engine.issuePath, 'runs', engine.runId, 'checks')))
    const implement0 = prompts.find((p) => p.stepId === 'implement' && p.round === 0)
    t.ok('but not before any check exists', implement0 && !implement0.prompt.includes("The run's check logs are readable"))
    const confirm = prompts.find((p) => p.stepId === 'confirm')
    t.ok('confirmation decided with the passing result in hand', confirm?.prompt.includes('"result": "passed"'))
    t.eq('the final revision passed its check', engine.run.checkResults.at(-1)?.result, 'passed')
    await releaseWorkspace(engine)
  }

  t.section('a strategy may keep checks before the audits')
  {
    const { engine, log, events } = await scenario({ concurrent: false })
    t.eq('the run completes', engine.run.status, 'completed', engine.run.blockedReason)
    t.ok('no audit ran while a check was running', log.every((a) => !a.checksRunning))
    await releaseWorkspace(engine)
  }
}
