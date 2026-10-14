import fs from 'node:fs/promises'
import path from 'node:path'
import { triageSuggestion } from '../server/runtime/triage-suggestion.mjs'
import { runResult } from '../server/runtime/run-result.mjs'
import { startStage } from './browser/stage.mjs'
import { openBrowser } from './browser/harness.mjs'
import { engineFixture, cleanupFixtures } from './fakes/fixture.mjs'
import { startRun, resumeRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { acquire } from '../server/runtime/lock.mjs'
import * as store from '../server/runtime/store.mjs'

export default async function (t) {
  const run = { status: 'completed', outcome: 'unresolved', steps: [{ number: '001' }] }
  const rejected = { '001': { valid: true, contract: 'triageResult', output: { fit: false } } }
  t.eq('triage rejection has its own result', runResult(run, rejected).result, 'rejected')
  t.eq('issue outcome is unchanged', run.outcome, 'unresolved')
  t.eq('missing evidence stays incomplete', runResult(run, {}).result, 'incomplete')
  t.eq('invalid output is not rejection', runResult(run, { '001': { ...rejected['001'], valid: false } }).result, 'incomplete')
  t.eq('confirmation refusal is not triage rejection', runResult(run, { '001': { valid: true, contract: 'confirmationResult', output: { satisfied: false } } }).result, 'incomplete')
  t.eq('cancelled run is not rejection', runResult({ ...run, status: 'cancelled' }, rejected).result, 'incomplete')
  t.eq('earlier triage cannot classify a later turn', runResult({ ...run, steps: [...run.steps, { number: '002' }] }, rejected).result, 'incomplete')
  t.eq('a live run has no result yet', runResult({ status: 'running', steps: [] }, {}).result, null)

  // A closed run says what it achieved; it never says "resolved".
  const closed = { status: 'completed', outcome: 'resolved', steps: [] }
  const report = { ...closed, playbook: { strategy: 'coordinated-analysis' }, delivery: { action: 'in-place', completedAt: 'x' },
    reportDisposition: { disposition: 'accepted', response: 'Six defects.', byStep: '005', issues: [{ key: 'a', kind: 'bug', issueId: 'i1' }, { key: 'b', kind: 'bug', title: 'Kept title', issueId: 'i1' }] } }
  const reported = runResult(report, { '005': { output: { issues: [{ key: 'a', title: 'From the output' }] } } })
  t.eq('an accepted analysis is reported', [reported.result, reported.resultLabel], ['reported', 'Report accepted — 2 findings'])
  t.eq('findings carry titles, from the receipt or the recorded output', reported.findings.map((x) => x.title), ['From the output', 'Kept title'])
  t.eq('the summary is the coordinator response', reported.resultSummary, 'Six defects.')
  t.eq('one finding is singular', runResult({ ...report, reportDisposition: { ...report.reportDisposition, issues: [{ key: 'a' }] } }, {}).resultLabel, 'Report accepted — 1 finding')
  t.eq('a report asking for information says so', runResult({ ...report, reportDisposition: { disposition: 'needs-information', issues: [] } }, {}).resultLabel, 'Report needs information')
  t.eq('source delivery is delivered', runResult({ ...closed, revisions: [{}], delivery: { action: 'apply-to-source', completedAt: 'x' } }, {}).result, 'delivered')
  t.eq('an applied retained patch is delivered', runResult({ ...closed, artifactApplication: { verified: true } }, {}).result, 'delivered')
  t.eq('a patch-only delivery is ready, not delivered', runResult({ ...closed, delivery: { action: 'worktree-diff', completedAt: 'x' } }, {}).result, 'artifact-ready')
  t.eq('staging is staged', runResult({ ...closed, playbook: { strategy: 'staging' } }, {}).result, 'staged')
  t.eq('deployment is deployed', runResult({ ...closed, playbook: { strategy: 'deployment' } }, {}).result, 'deployed')
  t.eq('nothing more specific is completed', runResult(closed, {}).result, 'completed')

  // A landing by hand is a person's claim, read as delivered; the record it sits on is not touched.
  const landed = { by: 'alice', applied: 'the approved patch', commit: 'abc1234', handChanges: 'none', landedAt: '2026-10-07T10:00:00.000Z', recordedAt: '2026-10-07T10:05:00.000Z' }
  const patchOnly = { ...closed, revisions: [{ fingerprint: 'r1' }], delivery: { action: 'worktree-diff', completedAt: 'x' }, landed }
  t.eq('a patch landed by hand is delivered, as a manual landing', [runResult(patchOnly, {}).result, runResult(patchOnly, {}).resultReason, runResult(patchOnly, {}).resultLabel], ['delivered', 'manual-landing', 'Landed by hand by alice'])
  const blockedLanded = { status: 'blocked', outcome: 'unresolved', blockedReason: 'source-delivery-blocked', revisions: [{ fingerprint: 'r1' }], closure: { conditions: { deliveryCompleted: false } }, steps: [], landed }
  t.eq('so is a run blocked at delivery whose patch a person applied', runResult(blockedLanded, {}).resultReason, 'manual-landing')
  t.eq('and the outcome and closure stay as the engine left them', [blockedLanded.outcome, blockedLanded.closure.conditions.deliveryCompleted], ['unresolved', false])

  // The landing is written through the run's engine, from what it reads once it
  // holds the run lock. Interleaved: the engine loads the run, another holder of
  // the lock then changes outcome, closure and approvals, and only then does
  // the landing take the lock. Those changes must survive the landing.
  {
    const f = await engineFixture()
    const engine = await startRun({ playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id },
      issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore,
      workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery })
    const done = await engine.drive()
    await releaseWorkspace(engine)
    t.ok('a settled run with a candidate to land', done.status === 'completed' && done.revisions.length > 0, done.status)

    const landing = await resumeRun({ issuePath: f.issuePath, runId: done.runId, harnesses: {}, configRoot: f.configRoot, takeLock: false })
    const other = await acquire(path.join(f.issuePath, '.run.lock'), { purpose: 'other-writer', runId: done.runId })
    const changed = await store.readRun(f.issuePath, done.runId)
    changed.outcome = 'resolved-by-other'
    changed.closure = { ...changed.closure, confirmed: 'other-writer' }
    changed.approvals = [...changed.approvals, { role: 'auditor-9', revision: 'other', step: '999' }]
    await store.writeRun(f.issuePath, done.runId, changed)
    await other.release()

    landing.runLock = await acquire(path.join(f.issuePath, '.run.lock'), { purpose: 'run', runId: done.runId })
    const landed = await landing.recordLanding({ by: 'tester', applied: 'the retained patch', commit: 'abc1234', checkout: null, handChanges: 'none', landedAt: null })
    await landing.runLock.release()
    const after = await store.readRun(f.issuePath, done.runId)
    t.eq('the landing is on the run', [after.landed?.by, after.landed?.commit, landed.revision], ['tester', 'abc1234', done.revisions.at(-1).fingerprint])
    t.eq('and what the other writer recorded after the engine loaded is kept', [after.outcome, after.closure.confirmed, after.approvals.length], ['resolved-by-other', 'other-writer', changed.approvals.length])

    let refused = null
    const again = await resumeRun({ issuePath: f.issuePath, runId: done.runId, harnesses: {}, configRoot: f.configRoot, takeLock: false })
    try { await again.recordLanding({ by: 'x', applied: 'y', commit: 'abc1234', handChanges: 'none' }) } catch (error) { refused = error.status }
    t.eq('without the run lock nothing is written', [refused, (await store.readRun(f.issuePath, done.runId)).landed.by], [409, 'tester'])
    again.runLock = await acquire(path.join(f.issuePath, '.run.lock'), { purpose: 'run', runId: done.runId })
    try { await again.recordLanding({ by: 'x', applied: 'y', commit: 'abc1234', handChanges: 'none' }); refused = null } catch (error) { refused = error.status }
    await again.runLock.release()
    t.eq('and a second claim, judged on the fresh record, is refused', refused, 409)
    await cleanupFixtures()
  }

  const snapshot = { phases: [{ step: { output: 'triageResult' } }] }
  t.eq('no triage has no suggestion', triageSuggestion({ phases: [] }, run, rejected), null)
  t.eq('legacy rejection does not invent closure advice', triageSuggestion(snapshot, run, rejected).label, 'Not recorded')
  t.eq('pending triage is explicit', triageSuggestion(snapshot, { steps: [] }, {}).label, 'Awaiting triage')
  const advice = { action: 'close-issue', reason: 'Already fixed' }
  t.eq('explicit coordinator advice is shown', triageSuggestion(snapshot, run, { '001': { ...rejected['001'], output: { fit: false, suggestion: advice } } }).source, 'coordinator')
  t.eq('operator override carries attribution', triageSuggestion(snapshot, run, rejected, { ...advice, source: 'operator' }).source, 'operator')

  const stage = await startStage({ control: { script: { fitVerdict: false } } })
  const issue = await stage.createIssue('Rejected at triage')
  const started = await stage.request(`/api/projects/${stage.project}/issues/${issue.id}/runs`, { method: 'POST', body: JSON.stringify({ playbook: 'implementation' }) })
  t.eq('run accepted', started.status, 201)
  let summary
  const deadline = Date.now() + 15000
  do {
    ;[summary] = await stage.runs(issue.id)
    if (summary?.status === 'completed') break
    await new Promise((r) => setTimeout(r, 50))
  } while (Date.now() < deadline)
  t.eq('run lifecycle completed', summary.status, 'completed')
  t.eq('list reports rejection', summary.result, 'rejected')
  const detail = await stage.run(issue.id, summary.runId)
  t.eq('detail reports triage rejection', detail.resultReason, 'triage-rejected')
  t.eq('issue resolution remains unresolved', detail.outcome, 'unresolved')
  await fs.writeFile(path.join(stage.issuesDir, stage.project, issue.id, 'runs', summary.runId, 'triage-suggestion.json'), JSON.stringify({ action: 'close-issue', reason: 'Close this superseded issue.', source: 'operator' }))
  const updated = await stage.run(issue.id, summary.runId)
  t.eq('API exposes suggested closure', updated.triageSuggestion.label, 'Close the issue')
  t.eq('advice does not resolve the run', updated.outcome, 'unresolved')
  const browser = await openBrowser(`${stage.origin}/projects/${stage.project}/${issue.id}`, { token: stage.token })
  try {
    await browser.until(() => browser.has('Triage judged this playbook a poor fit'))
    t.ok('suggestion is visible', browser.has('Triage suggests: Close the issue'))
    t.ok('historical override attributed honestly', browser.has('set by an operator'))
    const status = browser.all('.status')[0]
    t.ok('the status says what triage concluded', status.textContent.includes('poor fit'))
    t.ok('and does not say unresolved', !status.textContent.includes('unresolved') && !status.textContent.includes('incomplete'))
  } finally { browser.close(); await stage.stop() }
}
