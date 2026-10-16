import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { startRun, releaseOwnership, releaseWorkspace } from '../server/runtime/launch.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { readBarrier, addBarrierEntries } from '../server/runtime/cleanup-barrier.mjs'
import { hostPlatform, REAP_TAG } from '../server/runtime/platform.mjs'
import { alive } from '../server/runtime/process.mjs'
import { createSupervisor, supportedActions } from '../server/supervisor.mjs'
import { engineFixture, scriptFor, cleanupFixtures, simulateProcessDeath } from './fakes/fixture.mjs'

/*
 * What keeps an unproved cleanup on record across the moments it could be lost:
 * a crash between the turn's commit and the run blocking (the commit clears the
 * pending invocation that carried the tag), a concurrent sibling still in flight
 * when another sibling's scan was unproved, the issue being archived or deleted
 * while its run still bars the checkout, and one run's scan failing during the
 * startup reconcile of many.
 */
const P = 'devpanel-project'
const IN_PLACE = { isolation: 'in-place' }
const scan = (status) => ({ status, method: 'proc-environ', tag: crypto.randomUUID(), escaped: 0, reason: `${status} for the test` })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```'
const revision = (p) => (p.match(/Current revision: (sha256:[a-f0-9]{64})/) ?? [])[1] ?? null
const readRun = async (issuePath, runId) => JSON.parse(await fs.readFile(path.join(issuePath, 'runs', runId, 'run.json'), 'utf8'))
const proving = () => ({ ...hostPlatform(), descendantScan: { proved: true }, taggedProcesses: async () => ({ status: 'complete', method: 'test', pids: [] }) })

export default async function (t) {
  const reaps = {}
  const f = await engineFixture({ script: (turn) => {
    const base = scriptFor()(turn)
    return turn.stepId === 'implement' && reaps.next ? { text: base, diagnostics: { reap: reaps.next } } : base
  } })
  const projectDir = path.dirname(f.issuePath)
  const hash = async (runOptions) => (await resolvePlaybook(f.playbookId, { root: f.configRoot, runOptions, projectId: P })).resolved.configHash
  const start = async (issue, runOptions = {}) => startRun({ ...f, issue: { ...issue, project: P }, issuePath: issue.path,
    stepStore: { create: (o) => f.issues.createStep(P, issue.id, o) }, deliveryProvider: f.delivery, runOptions,
    ...(Object.keys(runOptions).length ? { expectConfigHash: await hash(runOptions) } : {}) })
  const supervisor = createSupervisor({ issues: f.issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir: path.dirname(f.projectPath), configRoot: f.configRoot, platform: proving() })
  const other = await f.issues.createIssue(P, { name: 'Another issue' })
  const admitted = async () => {
    const engine = await start(other, IN_PLACE).catch((e) => e)
    if (!engine?.runId) return engine?.code ?? engine?.message
    await engine.drive()
    await releaseOwnership(engine)
    return 'admitted'
  }
  /** An in-place run on a new issue that ends blocked with an unproved scan. */
  const unproved = async (name) => {
    const issue = await f.issues.createIssue(P, { name })
    reaps.next = scan('unavailable')
    try {
      const engine = await start(issue, IN_PLACE)
      await engine.drive()
      await releaseOwnership(engine)
      return { issue, engine }
    } finally { reaps.next = null }
  }

  t.section('D1. a crash after the turn is committed and before the run blocks keeps the cleanup on record (auditor-1-cleanup-persistence)')
  {
    const issue = await f.issues.createIssue(P, { name: 'Crash after commit' })
    const reap = scan('unavailable')
    reaps.next = reap
    const engine = await start(issue, IN_PLACE)
    engine.hooks.afterPersistBeforeAdvance = async (e) => {
      if (!e.run.steps.some((s) => s.stepId === 'implement')) return
      delete e.hooks.afterPersistBeforeAdvance
      throw Object.assign(new Error('owner crashed after the commit'), { injected: true })
    }
    const crashed = await engine.drive().then(() => null, (e) => e)
    reaps.next = null
    t.ok('the owner crashed at that point', crashed?.injected === true, crashed?.message)
    const run = await readRun(issue.path, engine.runId)
    t.ok('the implement turn was committed', run.steps.some((s) => s.stepId === 'implement'))
    t.eq('its pending invocation is gone with the commit', run.participants.implementer?.pendingInvocation ?? null, null)
    t.eq('the cleanup entry is on disk, open, with the turn\'s tag', run.cleanup?.entries?.map((e) => [e.tag, e.reason, Boolean(e.provedAt || e.acknowledgedAt)]), [[reap.tag, 'scan-unavailable', false]])
    t.eq('and the barrier holds it', (await readBarrier(projectDir)).entries.map((e) => [e.runId, e.tag]), [[engine.runId, reap.tag]])

    await simulateProcessDeath(issue.path)
    await supervisor.reconcile()
    const recovered = await readRun(issue.path, engine.runId)
    t.eq('reconcile marks it recovery-required and keeps the one entry', [recovered.blockedReason, recovered.cleanup.entries.length], ['recovery-required', 1])
    t.eq('another issue\'s in-place writer is refused', await admitted(), 'CLEANUP_BARRIER')
    t.eq('the stranded run offers the proof and the acknowledgement first', supportedActions(recovered).slice(0, 2), ['prove-cleanup', 'acknowledge-cleanup'])
    await supervisor.acknowledgeCleanup({ project: P, issueId: issue.id, runId: engine.runId, reason: 'checked the process table by hand', actor: 'tester' })
    t.eq('after the acknowledgement the writer is admitted', await admitted(), 'admitted')
  }

  t.section('D2. a sibling\'s unproved scan blocks the run only after every sibling settled (auditor-2-concurrent-block-window)')
  {
    const seats = { participants: { 'auditor-1': { model: 'gpt-6-astra' }, 'auditor-2': { model: 'gpt-6-astra' } } }
    let engine = null
    let seen = null
    const reap = scan('unavailable')
    const script = async (turn) => {
      const { stepId, prompt } = turn
      if (stepId === 'audit-implement-1') return { text: fence({ verdict: 'approved', artifactRevision: revision(prompt), findings: [], priorFindings: [] }), diagnostics: { reap } }
      if (stepId === 'audit-implement-2') {
        await sleep(500)
        const onDisk = await readRun(engine.issuePath, engine.runId)
        seen = { status: onDisk.status, tags: (onDisk.cleanup?.entries ?? []).map((e) => e.tag) }
        return fence({ verdict: 'approved', artifactRevision: revision(prompt), findings: [], priorFindings: [] })
      }
      return scriptFor()(turn)
    }
    const g = await engineFixture({ script })
    engine = await startRun({ ...g, deliveryProvider: g.delivery, runOptions: seats,
      expectConfigHash: (await resolvePlaybook(g.playbookId, { root: g.configRoot, runOptions: seats, projectId: P })).resolved.configHash })
    const r = await engine.drive()
    t.eq('while the sibling was in flight the run was still live on disk (a lost owner is recoverable)', seen?.status, 'running')
    t.eq('and the first reviewer\'s entry was already durable', seen?.tags, [reap.tag])
    t.eq('both reviews were recorded', r.steps.filter((s) => s.stepId.startsWith('audit-implement')).length, 2)
    t.eq('then it blocked cleanup-unproved', `${r.status}/${r.blockedReason}`, 'blocked/cleanup-unproved')
    t.eq('with nothing after the round', [r.steps.some((s) => s.stepId === 'confirm'), r.delivery ?? null], [false, null])
    await releaseWorkspace(engine)
  }

  t.section('D3. an archived (packed) issue\'s barrier entry is acknowledged from its metadata (auditor-1-orphaned-barrier)')
  {
    const { issue, engine } = await unproved('Archived with a barrier')
    await f.issues.setIssueArchived(P, issue.id, true, { overrideReason: 'test: archived while barred' })
    t.eq('the issue is packed', (await f.issues.getIssue(P, issue.id)).packed, true)
    t.eq('the barrier survives the archive', (await readBarrier(projectDir)).entries.map((e) => e.runId), [engine.runId])
    t.eq('the writer is refused', await admitted(), 'CLEANUP_BARRIER')
    const result = await supervisor.acknowledgeCleanup({ project: P, issueId: issue.id, runId: engine.runId, reason: 'archived; checked by hand', actor: 'tester' })
    t.eq('acknowledged from the barrier entry', result.acknowledged.tags, [engine.run.cleanup.entries[0].tag])
    const barrier = await readBarrier(projectDir)
    t.eq('lifted and recorded', [barrier.entries.length, barrier.history.at(-1).type, barrier.history.at(-1).issueId], [0, 'acknowledged', issue.id])
    t.eq('the writer is admitted', await admitted(), 'admitted')
  }

  t.section('D4. a deleted issue\'s barrier entry is proved (or acknowledged) from its metadata (auditor-1-orphaned-barrier)')
  {
    const proved = await unproved('Deleted, then proved')
    const acked = await unproved('Barred by the first').catch((e) => e)
    t.eq('a second in-place run of the project is barred by the first', acked?.code, 'CLEANUP_BARRIER')
    await f.issues.setIssueArchived(P, proved.issue.id, true, { overrideReason: 'test' })
    await f.issues.deleteIssue(P, proved.issue.id)
    t.eq('the issue is gone', (await f.issues.getIssue(P, proved.issue.id).catch((e) => e))?.status, 404)
    t.eq('its barrier entry is not', (await readBarrier(projectDir)).entries.map((e) => e.runId), [proved.engine.runId])
    const result = await supervisor.proveCleanup({ project: P, issueId: proved.issue.id, runId: proved.engine.runId, actor: 'tester' })
    t.eq('proved from the barrier entry', result.proved, true)
    t.eq('the writer is admitted', await admitted(), 'admitted')

    const { issue, engine } = await unproved('Deleted, then acknowledged')
    await f.issues.setIssueArchived(P, issue.id, true, { overrideReason: 'test' })
    await f.issues.deleteIssue(P, issue.id)
    await supervisor.acknowledgeCleanup({ project: P, issueId: issue.id, runId: engine.runId, reason: 'issue deleted; checked by hand', actor: 'tester' })
    t.eq('acknowledged from the barrier entry', (await readBarrier(projectDir)).history.at(-1).runId, engine.runId)
    t.eq('the writer is admitted', await admitted(), 'admitted')
    const nothing = await supervisor.acknowledgeCleanup({ project: P, issueId: issue.id, runId: engine.runId, reason: 'again', actor: 'tester' }).catch((e) => e)
    t.eq('with no entry left, a gone issue is 404', nothing?.status, 404)
  }

  t.section('D5. one run\'s failing scan does not stop the reconcile of the next (auditor-2-markunowned-barrier-throw)')
  {
    const failing = { ...hostPlatform(), descendantScan: { proved: true }, taggedProcesses: async (tag) => {
      if (tag === 'boom') throw new Error('the scan exploded')
      return { status: 'complete', method: 'test', pids: [] }
    } }
    const reconciler = createSupervisor({ issues: f.issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir: path.dirname(f.projectPath), configRoot: f.configRoot, platform: failing })
    const stranded = []
    for (const tag of ['boom', 'fine']) {
      const issue = await f.issues.createIssue(P, { name: `Stranded ${tag}` })
      const runId = `2026-01-01T00-00-00-000Z-${crypto.randomBytes(4).toString('hex')}`
      await fs.mkdir(path.join(issue.path, 'runs', runId), { recursive: true })
      await fs.writeFile(path.join(issue.path, 'runs', runId, 'run.json'), JSON.stringify({
        runId, issue: { project: P, id: issue.id }, playbook: { id: 'implementation', strategy: 'implementation' },
        status: 'running', startedAt: new Date().toISOString(), phase: { id: 'implement-review', round: 0 },
        participants: { implementer: { role: 'implementer', model: 'opus-5-5', harness: 'fake', state: 'ready',
          pendingInvocation: { invocationId: `inv-${tag}`, reapTag: tag, cursor: { stepId: 'implement' } } } },
        steps: [], revisions: [], approvals: [], checkResults: [], budgets: { limits: {}, used: {} }
      }))
      stranded.push({ tag, issue, runId })
    }
    const recovered = await reconciler.reconcile().then((r) => r, (e) => e)
    t.ok('reconcile completes', Array.isArray(recovered), recovered?.message)
    for (const { tag, issue, runId } of stranded) {
      const run = await readRun(issue.path, runId)
      t.eq(`${tag}: recovery-required`, run.blockedReason, 'recovery-required')
      // A scan that threw proves nothing: the tag stays open (fail closed), the error on its scan.
      const entry = run.cleanup?.entries?.[0]
      if (tag === 'boom') t.eq('boom: an open entry, its scan unavailable with the error', [entry?.tag, entry?.scan?.status, entry?.scan?.reason, Boolean(entry?.provedAt)], ['boom', 'unavailable', 'the scan exploded', false])
      else t.eq('fine: its tag was scanned and proved', [entry?.tag, Boolean(entry?.provedAt)], ['fine', true])
    }
  }

  /** A run persisted as live, in place, whose owner is gone with a turn in flight carrying `tag`. */
  const stranded = async (name, tag, extra = {}) => {
    const issue = await f.issues.createIssue(P, { name })
    const runId = `2026-01-01T00-00-00-000Z-${crypto.randomBytes(4).toString('hex')}`
    await fs.mkdir(path.join(issue.path, 'runs', runId), { recursive: true })
    await fs.writeFile(path.join(issue.path, 'runs', runId, 'run.json'), JSON.stringify({
      runId, issue: { project: P, id: issue.id, path: issue.path }, playbook: { id: 'implementation', strategy: 'implementation' },
      status: 'running', startedAt: new Date().toISOString(), phase: { id: 'implement-review', round: 0 },
      workspace: { isolation: 'in-place', path: f.projectPath, state: 'active' },
      participants: { implementer: { role: 'implementer', model: 'opus-5-5', harness: 'fake', state: 'ready',
        pendingInvocation: { invocationId: `inv-${name}`, reapTag: tag, cursor: { stepId: 'implement' } } } },
      steps: [], revisions: [], approvals: [], checkResults: [], budgets: { limits: {}, used: {} }, ...extra
    }))
    await fs.writeFile(path.join(issue.path, 'runs', runId, 'events.jsonl'), '')
    return { issue, runId }
  }

  t.section('D6. a barrier the file cannot take at startup keeps in-place admission closed (auditor-1-barrier-write-fail-open)')
  if (process.platform !== 'linux') t.skip('a real tagged survivor found by the linux scan', 'not linux')
  else {
    // The supervisor finds the project at <projectsDir>/<project id>: a link names the fixture's repository.
    const projectsDir = path.join(f.issuesDir, 'projects')
    await fs.mkdir(projectsDir, { recursive: true })
    await fs.symlink(f.projectPath, path.join(projectsDir, P))
    // A fresh supervisor is what a restart builds: it shares nothing with the one before.
    const fresh = () => createSupervisor({ issues: f.issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir, configRoot: f.configRoot, platform: hostPlatform() })
    const linux = fresh()
    const tag = crypto.randomUUID()
    const survivor = spawn('sleep', ['30'], { env: { ...process.env, [REAP_TAG]: tag }, stdio: 'ignore' })
    await new Promise((resolve) => survivor.once('spawn', resolve))
    const barred = await stranded('Crashed with a survivor', tag)
    const clean = await stranded('Crashed, nothing left', crypto.randomUUID())
    // The barrier's temporary file is a directory: every write fails with EISDIR.
    const tmp = path.join(projectDir, '.cleanup-barrier.json.tmp')
    await fs.mkdir(tmp)
    const recovered = await linux.reconcile().then((r) => r, (e) => e)
    t.ok('reconcile completes', Array.isArray(recovered), recovered?.message)
    t.eq('and reconciles the other run too', (await readRun(clean.issue.path, clean.runId)).blockedReason, 'recovery-required')
    const run = await readRun(barred.issue.path, barred.runId)
    t.eq('the survivor\'s entry is open on the run', run.cleanup?.entries?.map((e) => [e.tag, e.reason, Boolean(e.provedAt)]), [[tag, 'owner-lost', false]])
    t.ok('the failed write is on the run', /EISDIR/.test(run.recovery?.cleanupNoteFailed?.error ?? ''), run.recovery?.cleanupNoteFailed?.error)
    t.eq('the barrier file does not hold it', (await readBarrier(projectDir)).entries.filter((e) => e.runId === barred.runId), [])
    const inPlaceHash = await hash(IN_PLACE)
    const startOther = (supervisor = linux) => supervisor.start({ project: P, issueId: other.id, playbookId: f.playbookId, configRoot: f.configRoot, runOptions: IN_PLACE, expectConfigHash: inPlaceHash }).then((r) => r, (e) => e)
    const refused = await startOther()
    t.eq('another issue\'s in-place start is refused', [refused?.status, refused?.code], [409, 'CLEANUP_BARRIER'])
    t.ok('naming the run and why the barrier is held here', refused?.message?.includes(barred.runId) && /could not be written \(.*EISDIR/.test(refused.message), refused?.message)
    t.eq('the survivor is untouched', alive(survivor.pid), true)

    // A restart: the run record is the durable fact. A fresh supervisor's
    // reconcile reads it, cannot write the file either, and holds it.
    const restarted = fresh()
    await restarted.reconcile()
    const afterRestart = await startOther(restarted)
    t.ok('after a restart, a fresh supervisor still refuses, from the run record', afterRestart?.code === 'CLEANUP_BARRIER' && afterRestart.message.includes(barred.runId) && /could not be written/.test(afterRestart.message), afterRestart?.message)
    // Archiving would pack that record out of reconcile's reach: refused while the file does not hold it.
    await restarted.abandon({ project: P, issueId: barred.issue.id, runId: barred.runId })
    const archive = await f.issues.setIssueArchived(P, barred.issue.id, true, { overrideReason: 'test: archived while barred' }).then(() => null, (e) => e)
    t.ok('archiving the abandoned run\'s issue is refused while the barrier does not record it', archive?.status === 409 && /not proved gone/.test(archive.message), archive?.message)
    t.eq('the issue stays active', Boolean((await f.issues.getIssue(P, barred.issue.id)).packed), false)
    const afterArchive = fresh()
    await afterArchive.reconcile()
    t.eq('and a fresh supervisor still refuses the start', (await startOther(afterArchive))?.code, 'CLEANUP_BARRIER')
    t.eq('the survivor is still untouched', alive(survivor.pid), true)

    await fs.rm(tmp, { recursive: true })
    const again = await startOther()
    t.eq('once the file can be written, the admission writes it and still refuses', [again?.code, (await readBarrier(projectDir)).entries.filter((e) => e.runId === barred.runId).map((e) => e.tag)], ['CLEANUP_BARRIER', [tag]])
    t.ok('now from the file', !/could not be written/.test(again?.message ?? ''), again?.message)
    // With the barrier recorded, the archive goes ahead and the file carries the fact.
    const packed = await f.issues.setIssueArchived(P, barred.issue.id, true, { overrideReason: 'test: archived once recorded' }).then((i) => i, (e) => e)
    t.eq('with the barrier recorded, the archive goes ahead', packed?.packed, true)
    const afterPack = fresh()
    await afterPack.reconcile()
    t.eq('and a fresh supervisor refuses from the file', (await startOther(afterPack))?.code, 'CLEANUP_BARRIER')
    survivor.kill('SIGKILL')
    await afterPack.acknowledgeCleanup({ project: P, issueId: barred.issue.id, runId: barred.runId, reason: 'the sleep was killed by hand', actor: 'tester' })
    t.eq('after the acknowledgement the writer is admitted (OP-1)', await admitted(), 'admitted')

    t.section('D8. deleting a run, packing or deleting its issue cannot drop an unrecorded cleanup (auditor-2-delete-run-drops-barrier)')
    const tag2 = crypto.randomUUID()
    const survivor2 = spawn('sleep', ['30'], { env: { ...process.env, [REAP_TAG]: tag2 }, stdio: 'ignore' })
    await new Promise((resolve) => survivor2.once('spawn', resolve))
    const doomed = await stranded('Crashed, then deleted', tag2)
    await fs.mkdir(tmp)
    const first = fresh()
    await first.reconcile()
    t.ok('the barrier write failed and the start is refused', /could not be written/.test((await startOther(first))?.message ?? ''))
    await first.abandon({ project: P, issueId: doomed.issue.id, runId: doomed.runId })
    const refusedDelete = await first.deleteRun({ project: P, issueId: doomed.issue.id, runId: doomed.runId }).then(() => null, (e) => e)
    t.ok('deleting the run is refused, naming why', refusedDelete?.status === 409 && refusedDelete.code === 'CLEANUP_UNRECORDED' && /deleting the run would drop the only record/.test(refusedDelete.message), refusedDelete?.message)
    t.eq('and the run record stays', (await readRun(doomed.issue.path, doomed.runId)).cleanup?.entries?.map((e) => [e.tag, Boolean(e.provedAt || e.acknowledgedAt)]), [[tag2, false]])
    // An archive marker that did not pass the archive check (written by hand, or older): packing
    // (tools/pack-archived.mjs) and deleting the issue are refused all the same.
    const marker = path.join(doomed.issue.path, '.archive.json')
    await fs.writeFile(marker, JSON.stringify({ archivedAt: new Date().toISOString() }))
    const refusedPack = await f.issues.packArchived(P, doomed.issue.id).then(() => null, (e) => e)
    t.ok('packing the issue is refused', refusedPack?.status === 409 && /packing this issue would drop the only record/.test(refusedPack.message), refusedPack?.message)
    const refusedIssueDelete = await f.issues.deleteIssue(P, doomed.issue.id).then(() => null, (e) => e)
    t.ok('deleting the issue is refused', refusedIssueDelete?.status === 409 && /deleting this issue would drop the only record/.test(refusedIssueDelete.message), refusedIssueDelete?.message)
    await fs.rm(marker)
    const second = fresh()
    await second.reconcile()
    t.eq('a fresh supervisor\'s reconcile still refuses another issue\'s in-place start', (await startOther(second))?.code, 'CLEANUP_BARRIER')
    t.eq('the survivor is untouched', alive(survivor2.pid), true)

    await fs.rm(tmp, { recursive: true })
    await startOther(second)
    t.eq('once the file can be written it holds the entry', (await readBarrier(projectDir)).entries.filter((e) => e.runId === doomed.runId).map((e) => e.tag), [tag2])
    const deleted = await second.deleteRun({ project: P, issueId: doomed.issue.id, runId: doomed.runId }).then((r) => r, (e) => e)
    t.eq('then the deletion proceeds', deleted?.deleted, true)
    const third = fresh()
    await third.reconcile()
    const fromFile = await startOther(third)
    t.ok('and a fresh supervisor still refuses, from the file', fromFile?.code === 'CLEANUP_BARRIER' && fromFile.message.includes(doomed.runId) && !/could not be written/.test(fromFile.message), fromFile?.message)
    survivor2.kill('SIGKILL')
    await third.acknowledgeCleanup({ project: P, issueId: doomed.issue.id, runId: doomed.runId, reason: 'the sleep was killed by hand', actor: 'tester' })
    t.eq('after the acknowledgement the writer is admitted (OP-1)', await admitted(), 'admitted')
  }

  t.section('D7. a barrier entry the run no longer holds open is lifted (auditor-2-stale-barrier-after-crash-window)')
  {
    // The turn's barrier entry was written, then the owner crashed before the run record took it.
    const tag = crypto.randomUUID()
    const crashed = await stranded('Barrier written, record not', tag)
    await addBarrierEntries(projectDir, { issueId: crashed.issue.id, runId: crashed.runId, checkout: f.projectPath }, [{ tag, role: 'implementer', invocationId: 'inv', reason: 'scan-unavailable', structural: false, at: new Date().toISOString() }])
    t.eq('another writer is refused meanwhile', await admitted(), 'CLEANUP_BARRIER')
    await supervisor.reconcile()
    const run = await readRun(crashed.issue.path, crashed.runId)
    t.eq('the lost tag scans clean and is proved at detection', [run.cleanup?.entries?.[0]?.tag, Boolean(run.cleanup?.entries?.[0]?.provedAt)], [tag, true])
    const barrier = await readBarrier(projectDir)
    t.eq('its barrier entry is lifted, and the lift recorded', [barrier.entries.filter((e) => e.runId === crashed.runId).length, barrier.history.at(-1)?.type, barrier.history.at(-1)?.tags], [0, 'proved', [tag]])
    t.eq('the writer is admitted', await admitted(), 'admitted')

    // The same through the proof route: a proved run whose tag the barrier still holds.
    await addBarrierEntries(projectDir, { issueId: crashed.issue.id, runId: crashed.runId, checkout: f.projectPath }, [{ tag, role: 'implementer', invocationId: 'inv', reason: 'scan-unavailable', structural: false, at: new Date().toISOString() }])
    t.eq('no action is offered on the run, nothing being open', supportedActions(run).filter((a) => /cleanup/.test(a)), [])
    const proof = await supervisor.proveCleanup({ project: P, issueId: crashed.issue.id, runId: crashed.runId, actor: 'tester' })
    t.eq('the proof lifts the stale entry', [proof.proved, (await readBarrier(projectDir)).entries.filter((e) => e.runId === crashed.runId).length], [true, 0])
    t.eq('the writer is admitted again', await admitted(), 'admitted')
  }

  await cleanupFixtures()
}
