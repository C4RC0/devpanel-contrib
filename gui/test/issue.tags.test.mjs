import fs from 'node:fs/promises'
import path from 'node:path'

import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { engineFixture, scriptFor, blocking, cleanupFixtures } from './fakes/fixture.mjs'

export const name = 'issue list — each issue is tagged with what its newest run says'

const start = (f, extra = {}) => startRun({
  playbookId: f.playbookId,
  issue: { project: 'devpanel-project', id: f.issue.id },
  issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore,
  workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock,
  deliveryProvider: f.delivery, ...extra
})

export default async function (t) {
  t.section('1. an issue without runs says so')
  {
    const f = await engineFixture()
    const [issue] = await f.issues.listIssues('devpanel-project')
    t.eq('no latest run', issue.latestRun, null)
    t.eq('zero runs', issue.runCount, 0)
  }

  t.section('2. a resolved run tags the issue with its outcome, playbook and intent')
  {
    const f = await engineFixture({ playbook: 'implementation' })
    const engine = await start(f)
    await engine.drive()
    await releaseWorkspace(engine)
    const [issue] = await f.issues.listIssues('devpanel-project')
    t.eq('one run', issue.runCount, 1)
    t.eq('status and outcome', `${issue.latestRun.status}/${issue.latestRun.outcome}`, 'completed/resolved')
    t.eq('playbook', issue.latestRun.playbook, 'implementation')
    t.eq('implementation has no intent overlay, and none is invented', issue.latestRun.intent, null)
    t.eq('not live', issue.latestRun.live, false)
    t.eq('delivered', issue.latestRun.delivered, true)

    // Refactoring is the catalogue playbook that carries a default intent.
    const r = await engineFixture({ playbook: 'refactoring' })
    const refactor = await start(r)
    await refactor.drive()
    await releaseWorkspace(refactor)
    const [tagged] = await r.issues.listIssues('devpanel-project')
    t.eq('refactoring resolves', `${tagged.latestRun.status}/${tagged.latestRun.outcome}`, 'completed/resolved')
    t.eq('intent from the run record', tagged.latestRun.intent, 'refactoring')
  }

  t.section('3. a blocked run with retained work is tagged as such, and the newest run wins')
  {
    // The auditor never approves and the findings do not shrink: exhausted rounds end the run.
    const f = await engineFixture({ script: scriptFor({ implReviews: [[blocking('F1')]] }) })
    const exhaust = async (engine) => {
      await engine.drive()
      t.eq('exhausted rounds end the run without asking', `${engine.run.status}/${engine.run.pause ?? null}`, 'blocked/null')
    }
    const first = await start(f)
    await exhaust(first)
    await releaseWorkspace(first)
    f.clock.advance?.(1000)
    const second = await start(f)
    await exhaust(second)
    // Undelivered work stays; hand the issue back without discarding it.
    const { releaseOwnership } = await import('../server/runtime/launch.mjs')
    await releaseOwnership(second, { reason: 'test: keep the candidate' })
    const [issue] = await f.issues.listIssues('devpanel-project')
    t.eq('two runs counted', issue.runCount, 2)
    t.eq('the newest is reported', issue.latestRun.runId, second.runId)
    t.eq('blocked with the reason', `${issue.latestRun.status}:${issue.latestRun.blockedReason}`, 'blocked:rounds-exhausted')
    t.eq('work retained', issue.latestRun.workspaceRetained, true)
    t.eq('not recovery', issue.latestRun.recoveryRequired, false)
    await releaseWorkspace(second)
  }

  t.section('4. a run whose owner vanished is tagged recovery, never live')
  {
    const f = await engineFixture()
    const engine = await start(f)
    await engine.drive({ maxTurns: 1 })
    const file = path.join(f.issuePath, 'runs', engine.runId, 'run.json')
    const run = JSON.parse(await fs.readFile(file, 'utf8'))
    run.status = 'blocked'; run.blockedReason = 'recovery-required'; run.recovery = { required: true, reason: 'test', detectedAt: 'now' }
    await fs.writeFile(file, JSON.stringify(run))
    const [issue] = await f.issues.listIssues('devpanel-project')
    t.eq('recovery required', issue.latestRun.recoveryRequired, true)
    t.eq('and not live', issue.latestRun.live, false)
    engine.run.status = 'cancelled'
    await releaseWorkspace(engine)
  }

  t.section('5. a triage rejection is tagged rejected, as the run detail derives it')
  {
    const f = await engineFixture({ script: scriptFor({ fitVerdict: false }) })
    const engine = await start(f)
    await engine.drive()
    await releaseWorkspace(engine)
    const [issue] = await f.issues.listIssues('devpanel-project')
    t.eq('completed but unresolved', `${issue.latestRun.status}/${issue.latestRun.outcome}`, 'completed/unresolved')
    t.eq('derived result is rejected', issue.latestRun.result, 'rejected')
    t.eq('with the reason', issue.latestRun.resultReason, 'triage-rejected')
  }

  await cleanupFixtures()
}
