import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { startRun, resumeRun, releaseOwnership, releaseWorkspace } from '../server/runtime/launch.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { readBarrier, addBarrierEntries } from '../server/runtime/cleanup-barrier.mjs'
import { currentOwner } from '../server/runtime/lock.mjs'
import { hostPlatform, platformFor } from '../server/runtime/platform.mjs'
import { runProcess } from '../server/runtime/process.mjs'
import { createSupervisor, supportedActions } from '../server/supervisor.mjs'
import { engineFixture, scriptFor, cleanupFixtures, simulateProcessDeath } from './fakes/fixture.mjs'

/*
 * The operator acknowledgement (OP-1): besides a proof, a person may lift a
 * run's unproved cleanup — recorded with who, when, which run and why, refused
 * while the run is live. On darwin, until a Mac proves `ps -E` (OP-2, option
 * C), a scan that parses complete counts as complete with `mechanism:
 * 'unproved'`; one that does not leaves an entry no rescan can prove, so the
 * acknowledgement is the only way: the barrier says so and the proof is
 * refused. darwin is injected; nothing here reads a Mac.
 */
const P = 'devpanel-project'
const IN_PLACE = { isolation: 'in-place' }
const scan = (status, extra = {}) => ({ status, method: 'proc-environ', tag: crypto.randomUUID(), escaped: 0, reason: `${status} for the test`, ...extra })
// What process.mjs records on darwin for a listing that did not parse complete.
const structural = () => scan('incomplete', { method: 'ps-E', mechanism: 'unproved', reason: 'structural', notInspected: [4242], detail: 'the darwin reap inspection (ps -E) is not yet proved on a Mac' })
const darwinComplete = () => ({ status: 'complete', method: 'ps-E', mechanism: 'unproved', tag: crypto.randomUUID(), escaped: 0, detail: 'the darwin reap inspection (ps -E) is not yet proved on a Mac' })
// This host's probes (lock liveness), with a scan that must not be reached.
const noScan = { ...hostPlatform(), descendantScan: { proved: true }, taggedProcesses: async () => { throw new Error('no scan should run') } }
const BOOT = '0f2c1a3b-9d4e-4f5a-8b6c-7d8e9f0a1b2c'
const readRun = async (issue, runId) => JSON.parse(await fs.readFile(path.join(issue.path, 'runs', runId, 'run.json'), 'utf8'))

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
  const blockedRun = async (issue, reap, runOptions = IN_PLACE) => {
    reaps.next = reap
    const engine = await start(issue, runOptions)
    await engine.drive()
    reaps.next = null
    await releaseOwnership(engine)
    return engine
  }
  const reload = (issue, runId) => resumeRun({ issuePath: issue.path, runId, harnesses: f.harnesses, stepStore: { create: (o) => f.issues.createStep(P, issue.id, o) }, clock: f.clock, configRoot: f.configRoot, deliveryProvider: f.delivery, workspaceProvider: f.workspaceProvider, projectPath: f.projectPath })
  const supervisor = createSupervisor({ issues: f.issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir: path.dirname(f.projectPath), configRoot: f.configRoot, platform: noScan })
  const acknowledge = (issue, runId, reason = 'Checked by hand: no process carries the tag.', actor = 'tester') => supervisor.acknowledgeCleanup({ project: P, issueId: issue.id, runId, reason, actor })
  const a = { ...f.issue }
  const b = await f.issues.createIssue(P, { name: 'Second issue' })

  t.section('OP1-c. a reason is required')
  const first = await blockedRun(a, scan('unavailable'))
  {
    for (const reason of [undefined, '   ', 'x'.repeat(2001)]) {
      const refused = await supervisor.acknowledgeCleanup({ project: P, issueId: a.id, runId: first.runId, reason, actor: 'tester' }).catch((e) => e)
      t.eq(`reason ${reason === undefined ? 'missing' : reason.trim() ? 'too long' : 'blank'}: 400`, refused?.status, 400)
    }
    t.eq('nothing was lifted', (await readBarrier(projectDir)).entries.length, 1)
  }

  t.section('OP1-f. an abandoned run offers it before start-new')
  {
    await supervisor.abandon({ project: P, issueId: a.id, runId: first.runId })
    t.eq('prove and acknowledge come first', supportedActions(await readRun(a, first.runId)), ['prove-cleanup', 'acknowledge-cleanup', 'start-new'])
  }

  t.section('OP1-a. an acknowledgement lifts the barrier and records who, when, which run and why')
  {
    const result = await acknowledge(a, first.runId)
    t.eq('acknowledged by the actor, with the reason', [result.acknowledged.by, result.acknowledged.reason], ['tester', 'Checked by hand: no process carries the tag.'])
    const barrier = await readBarrier(projectDir)
    t.eq('the barrier is empty', barrier.entries, [])
    const lift = barrier.history.at(-1)
    t.eq('the history names the lift', [lift.type, lift.issueId, lift.runId, lift.by, lift.reason, typeof lift.at], ['acknowledged', a.id, first.runId, 'tester', 'Checked by hand: no process carries the tag.', 'string'])
    const run = await readRun(a, first.runId)
    t.eq('the run\'s entry carries the same record', [run.cleanup.entries[0].acknowledgement.by, run.cleanup.entries[0].acknowledgement.reason, Boolean(run.cleanup.entries[0].acknowledgedAt)], ['tester', 'Checked by hand: no process carries the tag.', true])
    t.eq('after it only start-new is offered', supportedActions(run), ['start-new'])
    const admitted = await start(b, IN_PLACE)
    t.ok('an in-place start on another issue is admitted', Boolean(admitted.runId))
    await admitted.drive()
    await releaseOwnership(admitted)
  }

  t.section('OP1-b. refused while the run is live')
  {
    const c = await f.issues.createIssue(P, { name: 'Live run' })
    const engine = await blockedRun(c, scan('unavailable'))
    const file = path.join(c.path, 'runs', engine.runId, 'run.json')
    const record = JSON.parse(await fs.readFile(file, 'utf8'))
    await fs.writeFile(file, JSON.stringify({ ...record, status: 'running' }))
    const live = await acknowledge(c, engine.runId).catch((e) => e)
    t.eq('a run that claims to be running: 409', live?.status, 409)
    await fs.writeFile(file, JSON.stringify(record))
    await fs.writeFile(path.join(c.path, '.run.lock'), JSON.stringify({ purpose: 'run', token: 'held', owner: await currentOwner(engine.runId) }))
    const owned = await acknowledge(c, engine.runId).catch((e) => e)
    t.eq('a run whose lock has a live owner: 409', owned?.status, 409)
    t.eq('the barrier is unchanged', (await readBarrier(projectDir)).entries.map((e) => e.runId), [engine.runId])
    await fs.rm(path.join(c.path, '.run.lock'))
    await acknowledge(c, engine.runId)
    t.eq('settled, it is accepted', (await readBarrier(projectDir)).entries, [])
  }

  t.section('OP1-d. an acknowledged worktree run resumes without a proof')
  {
    const d = await f.issues.createIssue(P, { name: 'Worktree run' })
    const engine = await blockedRun(d, scan('incomplete'), {})
    t.eq('blocked cleanup-unproved', engine.run.blockedReason, 'cleanup-unproved')
    t.eq('a worktree run puts nothing on the project barrier', (await readBarrier(projectDir)).entries, [])
    await acknowledge(d, engine.runId)
    const resumed = await reload(d, engine.runId)
    resumed.platform = noScan
    await resumed.resumeExecution()
    const done = await resumed.drive()
    t.eq('and completes', done.status, 'completed', done.blockedReason)
    await releaseWorkspace(resumed)
  }

  t.section('OP1-e. the acknowledgement works for a run whose record is gone')
  {
    await addBarrierEntries(projectDir, { issueId: b.id, runId: 'deleted-run', checkout: f.projectPath }, [{ tag: 'gone-tag', role: 'implementer', invocationId: 'x', reason: 'scan-unavailable', structural: false, at: new Date().toISOString() }])
    await acknowledge(b, 'deleted-run', 'The run was deleted; checked the process table.')
    const barrier = await readBarrier(projectDir)
    t.eq('lifted and recorded', [barrier.entries.length, barrier.history.at(-1).runId, barrier.history.at(-1).type], [0, 'deleted-run', 'acknowledged'])
  }

  t.section('OP2-c. darwin, a turn whose listing parsed complete: complete, named unproved, and the run goes on')
  {
    const h = await f.issues.createIssue(P, { name: 'darwin complete' })
    const reap = darwinComplete()
    const engine = await blockedRun(h, reap)
    const run = await readRun(h, engine.runId)
    t.eq('the run completes', run.status, 'completed', run.blockedReason)
    t.eq('the step keeps the scan, complete with mechanism unproved', [run.steps.find((s) => s.stepId === 'implement')?.reap?.status, run.steps.find((s) => s.stepId === 'implement')?.reap?.mechanism], ['complete', 'unproved'])
    t.eq('no cleanup entry, nothing on the barrier', [run.cleanup ?? null, (await readBarrier(projectDir)).entries.length], [null, 0])
  }

  t.section('OP2-a. darwin, an incomplete listing: the barrier says so and the acknowledgement is the only path')
  {
    const darwinSupervisor = createSupervisor({ issues: f.issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir: path.dirname(f.projectPath), configRoot: f.configRoot, platform: platformFor('darwin', { exec: async () => ({ ok: false, code: 1, stdout: '', error: 'not a mac' }) }) })
    const e = await f.issues.createIssue(P, { name: 'darwin run' })
    const engine = await blockedRun(e, structural())
    const run = await readRun(e, engine.runId)
    t.eq('blocked, the entry structural', [run.blockedReason, run.cleanup.entries[0].reason, run.cleanup.entries[0].structural], ['cleanup-unproved', 'scan-structural', true])
    const refused = await start(b, IN_PLACE).then(() => null, (x) => x)
    t.ok('the barrier states no rescan here can prove it', refused?.code === 'CLEANUP_BARRIER' && /cannot prove this cleanup on this host/.test(refused.message), refused?.message)
    t.eq('only the acknowledgement is offered', supportedActions(run).slice(0, 2), ['acknowledge-cleanup', 'resume'])
    const proof = await darwinSupervisor.proveCleanup({ project: P, issueId: e.id, runId: engine.runId, actor: 'tester' }).catch((x) => x)
    t.eq('the proof is refused', [proof?.status, proof?.code], [409, 'SCAN_UNAVAILABLE'])
    const resumed = await reload(e, engine.runId)
    resumed.platform = platformFor('darwin', { exec: async () => ({ ok: false, code: 1, stdout: '', error: 'not a mac' }) })
    const resume = await resumed.resumeExecution().catch((x) => x)
    t.ok('resume asks for an acknowledgement', resume?.status === 409 && /acknowledg/.test(resume.message), resume?.message)
    await releaseOwnership(resumed)
    await darwinSupervisor.acknowledgeCleanup({ project: P, issueId: e.id, runId: engine.runId, reason: 'darwin: checked ps by hand', actor: 'tester' })
    const admitted = await start(b, IN_PLACE)
    t.ok('after the acknowledgement the start is admitted', Boolean(admitted.runId))
    await admitted.drive()
    await releaseOwnership(admitted)
  }

  t.section('OP2-e. darwin, a row of ours without its command field: the turn blocks, nothing is recorded complete (auditor-1-empty-process-row)')
  {
    // The record is runProcess's own, from a listing whose row '4242 <uid> S' has no command and no environment.
    const bare = platformFor('darwin', { uid: () => process.getuid(), exec: async () => ({ ok: true, code: 0, stdout: `${process.pid} ${process.getuid()} S node\n4242 ${process.getuid()} S\n` }) })
    const reap = { ...(await runProcess({ command: 'true', reap: true, platform: bare })).leftovers.scan }
    const e = await f.issues.createIssue(P, { name: 'darwin bare row' })
    const engine = await blockedRun(e, reap, {})
    const run = await readRun(e, engine.runId)
    const step = run.steps.find((s) => s.stepId === 'implement')
    t.eq('the turn blocks cleanup-unproved', `${run.status}/${run.blockedReason}`, 'blocked/cleanup-unproved')
    t.eq('the step\'s scan is incomplete, naming the pid', [step?.reap?.status, step?.reap?.notInspected], ['incomplete', [4242]])
    t.eq('its entry is structural: only an acknowledgement settles it', [run.cleanup.entries[0].reason, run.cleanup.entries[0].structural], ['scan-structural', true])
    t.ok('nothing is recorded complete', ![step?.reap, ...run.cleanup.entries.map((x) => x.scan)].some((s) => s?.status === 'complete'))
    await releaseWorkspace(engine).catch(() => {})
  }

  t.section('OP2-b. darwin, owner lost: the lost tag stays open and only the acknowledgement lifts it')
  {
    const g = await engineFixture()
    const gDir = path.dirname(g.issuePath)
    // A darwin boot uuid: the lock this (Linux) engine wrote reads as another
    // boot, so its owner is dead; ps -E fails.
    const darwin = platformFor('darwin', { exec: async (command) => command.endsWith('sysctl')
      ? { ok: true, code: 0, stdout: `${BOOT}\n` }
      : { ok: false, code: 1, stdout: '', error: 'not a mac' } })
    const gSupervisor = createSupervisor({ issues: g.issues, harnessDir: path.join(g.configRoot, 'harness'), projectsDir: path.dirname(g.projectPath), configRoot: g.configRoot, platform: darwin })
    const engine = await startRun({ ...g, deliveryProvider: g.delivery, runOptions: IN_PLACE, expectConfigHash: (await resolvePlaybook(g.playbookId, { root: g.configRoot, runOptions: IN_PLACE, projectId: P })).resolved.configHash })
    engine.hooks.beforeInvoke = async (x) => {
      if (!Object.values(x.run.participants).some((p) => p.pendingInvocation?.cursor?.stepId === 'implement')) return
      delete x.hooks.beforeInvoke
      throw Object.assign(new Error('owner crashed'), { injected: true })
    }
    await engine.drive().catch(() => {})
    await simulateProcessDeath(g.issuePath)
    await gSupervisor.reconcile()
    const entry = (await readRun(g.issue, engine.runId)).cleanup?.entries?.[0]
    t.eq('an open, structural owner-lost entry', [entry?.reason, entry?.structural, Boolean(entry?.provedAt)], ['owner-lost', true, false])
    t.eq('on the barrier', (await readBarrier(gDir)).entries.map((x) => x.runId), [engine.runId])
    await gSupervisor.acknowledgeCleanup({ project: P, issueId: g.issue.id, runId: engine.runId, reason: 'host rebooted; nothing left', actor: 'tester' })
    t.eq('the acknowledgement lifted it', (await readBarrier(gDir)).entries, [])
  }

  t.section('OP2-d. darwin, owner lost, the listing parses complete and finds nothing: proved at detection, named unproved')
  {
    const g = await engineFixture()
    const gDir = path.dirname(g.issuePath)
    // Another boot, as in OP2-b; ps -E lists this process and nothing tagged.
    const darwin = platformFor('darwin', { exec: async (command, args) => command.endsWith('sysctl')
      ? { ok: true, code: 0, stdout: `${BOOT}\n` }
      : args.includes('-E')
        ? { ok: true, code: 0, stdout: `${process.pid} ${process.getuid()} S node test/run.mjs\n` }
        : { ok: false, code: 1, stdout: '', error: 'not a mac' } })
    const gSupervisor = createSupervisor({ issues: g.issues, harnessDir: path.join(g.configRoot, 'harness'), projectsDir: path.dirname(g.projectPath), configRoot: g.configRoot, platform: darwin })
    const engine = await startRun({ ...g, deliveryProvider: g.delivery, runOptions: IN_PLACE, expectConfigHash: (await resolvePlaybook(g.playbookId, { root: g.configRoot, runOptions: IN_PLACE, projectId: P })).resolved.configHash })
    engine.hooks.beforeInvoke = async (x) => {
      if (!Object.values(x.run.participants).some((p) => p.pendingInvocation?.cursor?.stepId === 'implement')) return
      delete x.hooks.beforeInvoke
      throw Object.assign(new Error('owner crashed'), { injected: true })
    }
    await engine.drive().catch(() => {})
    await simulateProcessDeath(g.issuePath)
    await gSupervisor.reconcile()
    const entry = (await readRun(g.issue, engine.runId)).cleanup?.entries?.[0]
    t.eq('an owner-lost entry proved at detection, its scan complete with mechanism unproved', [entry?.reason, Boolean(entry?.provedAt), entry?.scan?.status, entry?.scan?.mechanism], ['owner-lost', true, 'complete', 'unproved'])
    t.eq('nothing on the barrier', (await readBarrier(gDir)).entries, [])
  }

  await cleanupFixtures()
}
