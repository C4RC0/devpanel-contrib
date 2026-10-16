import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { startRun, resumeRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { readRun, readEvents } from '../server/runtime/store.mjs'
import { captureIntegrity, readIntegrity } from '../server/runtime/integrity.mjs'
import { integrateRun } from '../server/runtime/integrate.mjs'
import { workspaceDisposition, supportedActions } from '../server/supervisor.mjs'
import { engineFixture, scriptFor, simulateProcessDeath } from './fakes/fixture.mjs'

export const name = 'engine — per-turn source permissions and integrity quarantine'
const exec = promisify(execFile)
const git = (cwd, args) => exec('git', ['-C', cwd, ...args])
const start = (f) => startRun({ ...f, issue: { project: 'devpanel-project', id: f.issue.id }, deliveryProvider: f.delivery })
const rejected = async (fn) => { try { await fn(); return null } catch (e) { return e } }

export default async function (t) {
  // An auditor turn before any candidate exists is plan-and-implement's plan
  // audit; everything else runs under implementation.
  async function changedTurn ({ role = 'auditor-1', fail = false, abort = false, change, stepId = role === 'implementer' ? 'implement' : 'audit-plan-1', message = 'simulated failed turn', payload = undefined, availability = undefined }) {
    const f = await engineFixture({ playbook: stepId.startsWith('audit-plan') ? 'plan-and-implement' : 'implementation' })
    if (availability) f.availability = availability
    const original = f.fake.invoke
    let current = null
    f.fake.invoke = async (args) => {
      if (args.meta.stepId === stepId) {
        await change(args.cwd, args, current)
        if (fail || abort) throw Object.assign(new Error(message), { name: abort ? 'AbortError' : 'Error', payload })
      }
      return original(args)
    }
    const engine = await start(f)
    current = engine
    // A terminal runtime failure is rethrown for the supervisor to record; a
    // quarantined one returns. Either way the run record is what is asserted.
    let thrown = null
    try { await engine.drive() } catch (error) { if (!fail) throw error; thrown = error }
    return { f, engine, thrown }
  }

  t.section('a coordination-only seat cannot reach the worktree by construction')
  {
    const seen = []
    const { engine } = await changedTurn({ role: 'coordinator', stepId: 'triage', change: (cwd, args, e) => { seen.push({ cwd, toolFree: args.supervisorOnly === true, workspace: e.run.workspace.path }) } })
    t.ok('its working directory is the scratch directory, not the worktree', seen[0] && seen[0].cwd !== seen[0].workspace, JSON.stringify(seen[0]))
    t.ok('and it runs tool-free', seen[0]?.toolFree === true)
    t.eq('so no whole-tree capture is taken for its turn', engine.run.steps.filter((x) => x.role === 'coordinator').length > 0 && !(await readEvents(engine.issuePath, engine.runId)).events.some((e) => e.type === 'turn-integrity' && e.role === 'coordinator'), true)
    await releaseWorkspace(engine)
  }

  t.section('a coordinator that escaped its fence is still caught at the next capture')
  {
    const { f, engine } = await changedTurn({ role: 'coordinator', stepId: 'triage',
      change: (_cwd, _args, e) => fs.writeFile(path.join(e.run.workspace.path, 'source.txt'), 'unauthorized') })
    const run = await readRun(f.issuePath, engine.runId)
    t.eq('quarantined', run.integrity.status, 'quarantined')
    t.eq('no revision accepted', run.revisions.length, 0)
    t.eq('changed path attributed', run.integrity.latest.changes.paths, [{ path: 'source.txt', change: 'modified' }])
    t.eq('attributed to the uncaptured coordinator turn', run.integrity.latest.role, 'coordinator')
    t.eq('and the attribution says it is inferred', run.integrity.latest.attribution, 'inferred-from-uncaptured-turns')
    t.eq('partial work retained', await fs.readFile(path.join(run.workspace.path, 'source.txt'), 'utf8'), 'unauthorized')
    t.eq('delivery never attempted', f.delivery.calls.length, 0)
    await releaseWorkspace(engine)
  }
  {
    const { f, engine } = await changedTurn({ role: 'coordinator', stepId: 'triage', fail: true,
      change: (_cwd, _args, e) => fs.writeFile(path.join(e.run.workspace.path, 'source.txt'), 'unauthorized') })
    const run = await readRun(f.issuePath, engine.runId)
    t.eq('a failed escaping coordinator turn ends the run as a recorded failure, without a revision', [run.failure?.message, run.revisions.length], ['simulated failed turn', 0])
    t.eq('delivery never attempted', f.delivery.calls.length, 0)
    const resumed = await rejected(() => engine.resumeExecution())
    t.ok('continuing it is refused', Boolean(resumed), resumed?.message)
    await releaseWorkspace(engine)
  }

  t.section('non-writers cannot modify source before the first candidate, on success or failure')
  for (const role of ['auditor-1']) {
    for (const fail of [false, true]) {
      const { f, engine } = await changedTurn({ role, fail, stepId: role === 'coordinator' ? 'triage' : 'audit-plan-1',
        change: (cwd) => fs.writeFile(path.join(cwd, 'source.txt'), 'unauthorized') })
      const run = await readRun(f.issuePath, engine.runId)
      t.eq(`${role}/${fail}: quarantined`, run.integrity.status, 'quarantined')
      t.eq('no first revision accepted', run.revisions.length, 0)
      t.eq('run blocked', run.blockedReason, 'recovery-required')
      t.eq('changed path attributed', run.integrity.latest.changes.paths, [{ path: 'source.txt', change: 'modified' }])
      t.eq('role attributed', run.integrity.latest.role, role)
      t.eq('partial work retained', await fs.readFile(path.join(run.workspace.path, 'source.txt'), 'utf8'), 'unauthorized')
      const count = await f.fake.ledger.invocationCount()
      await engine.drive()
      await engine.recover()
      await engine.evaluateClosure()
      t.eq('drive and recovery cannot repeat work', await f.fake.ledger.invocationCount(), count)
      t.eq('delivery never attempted', f.delivery.calls.length, 0)
      t.eq('no normal actions offered: only an integrity disposition or abandonment', supportedActions(run), ['resolve-integrity', 'abandon'])
      t.eq('even apparently unchanged quarantine is retained', workspaceDisposition(run, { unchanged: true, proven: true }).discard, false)
      const denied = await rejected(() => integrateRun({ issuePath: f.issuePath, runId: engine.runId }))
      t.ok('integration refuses quarantine', /integrity/.test(denied?.message))
      await releaseWorkspace(engine)
    }
  }

  t.section('unexpected files, deletions, executable modes and Git-only changes')
  for (const [label, change, field] of [
    ['untracked', (cwd) => fs.writeFile(path.join(cwd, 'surprise.js'), 'new source'), 'paths'],
    ['ignored', async (cwd) => { await fs.writeFile(path.join(cwd, '.gitignore'), 'hidden.js\n'); await fs.writeFile(path.join(cwd, 'hidden.js'), 'source') }, 'paths'],
    ['deleted', (cwd) => fs.rm(path.join(cwd, 'source.txt')), 'paths'],
    ['mode', (cwd) => fs.chmod(path.join(cwd, 'source.txt'), 0o755), 'paths'],
    ['index', (cwd) => git(cwd, ['update-index', '--assume-unchanged', 'source.txt']), 'index'],
    ['HEAD', (cwd) => git(cwd, ['commit', '--allow-empty', '-qm', 'unauthorized history']), 'head']
  ]) {
    const { engine } = await changedTurn({ change })
    // Private repositories (0d): the work tree's Git directory is the worker's
    // own — read-only to this seat inside the fence, never read by the host —
    // and the engine's index and HEAD are out of every seat's reach. A
    // Git-only change there is not a change to the source.
    if (engine.run.workspace.repository?.kind === 'private' && field !== 'paths') {
      t.eq(`${label}: the worker's own Git state is not the source`, engine.run.integrity.status, 'clear')
      const { stdout } = await exec('git', ['--git-dir', engine.run.workspace.gitDir, 'rev-parse', 'HEAD'])
      t.eq(`${label}: the engine's HEAD is still the base`, stdout.trim(), engine.run.workspace.baseCommit)
      await releaseWorkspace(engine)
      continue
    }
    t.eq(`${label}: quarantined`, engine.run.integrity.status, 'quarantined')
    t.ok(`${label}: change identified`, Boolean(engine.run.integrity.latest.changes[field]))
    await releaseWorkspace(engine)
  }

  t.section('the same role fence applies after a candidate exists')
  {
    const { engine, f } = await changedTurn({ stepId: 'audit-implement-1', change: (cwd) => fs.writeFile(path.join(cwd, 'source.txt'), 'auditor patch') })
    t.eq('candidate existed before the audit', engine.run.revisions.length, 1)
    t.eq('auditor edit quarantined', engine.run.integrity.status, 'quarantined')
    t.eq('audit response not accepted', engine.run.steps.some((s) => s.stepId === 'audit-implement-1'), false)
    t.eq('checks invalidated', engine.run.checkResults, [])
    t.eq('no delivery', f.delivery.calls.length, 0)
    await releaseWorkspace(engine)
  }

  t.section('persisted pre-turn state catches edits across process death')
  {
    const f = await engineFixture()
    const engine = await start(f)
    engine.hooks.beforeInvoke = () => { throw new Error('simulated process death') }
    await rejected(() => engine.drive())
    // The first turn is the coordinator's triage: tool-free, so its baseline is
    // the run's persisted checkpoint rather than a capture of its own.
    t.ok('first turn has a persisted baseline', Object.values(engine.run.participants).some((p) => p.pendingInvocation?.integrityBefore || (p.pendingInvocation?.integrity === 'not-applicable' && engine.run.integrity?.checkpoint)))
    // Model the process dying after a write, before any engine-side post-check.
    await fs.writeFile(path.join(engine.run.workspace.path, 'source.txt'), 'interrupted source edit')
    await simulateProcessDeath(f.issuePath)
    const resumed = await resumeRun({ issuePath: f.issuePath, runId: engine.runId, harnesses: f.harnesses, stepStore: f.stepStore, clock: f.clock })
    await resumed.recover()
    await rejected(() => resumed.drive())
    t.eq('the edit is caught before any working seat runs on it', resumed.run.integrity.status, 'quarantined')
    t.eq('no revision adopted', resumed.run.revisions.length, 0)
    t.eq('no working seat invoked', (await f.fake.ledger.entries()).filter((e) => e.phase === 'started' && e.role !== 'coordinator').length, 0)
    await releaseWorkspace(resumed)
  }

  t.section('tracked files under exclusions and unreadable Git state cannot disappear from coverage')
  {
    const f = await engineFixture()
    await fs.mkdir(path.join(f.projectPath, 'node_modules'))
    await fs.writeFile(path.join(f.projectPath, 'node_modules', 'tracked.js'), 'tracked dependency')
    await git(f.projectPath, ['add', '-f', 'node_modules/tracked.js'])
    await git(f.projectPath, ['commit', '-qm', 'tracked dependency'])
    const engine = await start(f)
    const before = await readIntegrity(engine.integrityDir(), 'initial')
    t.ok('tracked excluded file included', before.entries.some((e) => e.path === 'node_modules/tracked.js'))
    const original = f.fake.invoke
    f.fake.invoke = async (args) => {
      // Into the worktree whatever the seat's cwd: a coordination-only seat's is
      // its scratch directory.
      await fs.writeFile(path.join(engine.run.workspace.path, 'node_modules/tracked.js'), 'changed')
      return original(args)
    }
    await engine.drive()
    t.eq('tracked excluded source change quarantined', engine.run.integrity.status, 'quarantined')
    await releaseWorkspace(engine)
  }
  t.section('submodule pointers (gitlinks) are tracked by commit, not required as files')
  {
    const f = await engineFixture()
    const pointer = '53e476982c7cfd0d051572f07d29d4650199b569'
    await git(f.projectPath, ['update-index', '--add', '--cacheinfo', `160000,${pointer},modules/vendored`])
    await git(f.projectPath, ['commit', '-qm', 'vendored module pointer'])
    await fs.mkdir(path.join(f.projectPath, 'modules/vendored'), { recursive: true })   // what a checkout leaves behind
    const engine = await start(f)
    const before = await readIntegrity(engine.integrityDir(), 'initial')
    const link = before.entries.find((e) => e.path === 'modules/vendored')
    t.eq('gitlink recorded by pointer', link?.mode, 'gitlink')
    t.ok('empty placeholder directory tolerated', (await fs.stat(path.join(engine.run.workspace.path, 'modules/vendored'))).isDirectory())
    t.ok('gitlink is not a tracked file path', !before.trackedPaths.includes('modules/vendored'))
    const again = await captureIntegrity(engine.run.workspace, { clock: engine.clock, trackedPaths: before.trackedPaths })
    t.eq('repeat capture is stable', again.hash, before.hash)
    await engine.drive()
    t.eq('run proceeds past the pointer', engine.run.integrity.status, 'clear')
    const moved6 = pointer.replace(/^5/, '6')
    if (engine.run.workspace.repository?.kind === 'private') {
      // The seat's index cannot move a pointer: gitlinks are carried from the
      // snapshot (the engine's index), which no seat can write.
      await git(engine.run.workspace.path, ['update-index', '--cacheinfo', `160000,${moved6},modules/vendored`])
      const unmoved = await captureIntegrity(engine.run.workspace, { clock: engine.clock, trackedPaths: before.trackedPaths })
      t.eq('a pointer moved in the worker index is not taken from it', unmoved.entries.find((e) => e.path === 'modules/vendored').contentHash, link.contentHash)
      await exec('git', ['--git-dir', engine.run.workspace.gitDir, '--work-tree', engine.run.workspace.path, 'update-index', '--cacheinfo', `160000,${moved6},modules/vendored`])
    } else await git(engine.run.workspace.path, ['update-index', '--cacheinfo', `160000,${moved6},modules/vendored`])
    const moved = await captureIntegrity(engine.run.workspace, { clock: engine.clock, trackedPaths: before.trackedPaths })
    t.ok('pointer change is a path change', moved.entries.find((e) => e.path === 'modules/vendored').contentHash !== link.contentHash)
    await releaseWorkspace(engine)
  }
  {
    const { engine } = await changedTurn({ change: (cwd) => fs.writeFile(path.join(cwd, '.git'), 'invalid metadata') })
    t.eq('unverifiable Git state quarantined', engine.run.integrity.status, 'quarantined')
    // With the git directory recorded at provisioning (engine-git.mjs) the
    // capture no longer fails on the invalid entry; it names the replacement.
    t.ok('explicit integrity failure', /\.git entry was replaced|cannot verify source integrity/.test(engine.run.integrity.latest.reason), engine.run.integrity.latest.reason)
    // Restore the worktree pointer solely so the fixture can be removed by Git.
    const before = await readIntegrity(engine.integrityDir(), engine.run.integrity.latest.before)
    await fs.writeFile(path.join(engine.run.workspace.path, '.git'), `gitdir: ${before.repository.gitDir}\n`)
    await releaseWorkspace(engine)
  }

  t.section('read-only Git inspection and scratch output remain permitted')
  {
    const f = await engineFixture()
    const original = f.fake.invoke
    const policies = []
    f.fake.invoke = async (args) => {
      policies.push({ role: args.meta.role, writesCode: args.tooling?.writesCode ?? false, toolFree: args.supervisorOnly === true })
      await fs.writeFile(path.join(args.scratchDir, `${args.meta.invocationId}.txt`), 'notes')
      // Git inspection is a working seat's; a tool-free coordinator has neither shell nor worktree.
      if (!args.supervisorOnly) await git(args.cwd, ['status', '--porcelain'])
      return original(args)
    }
    const engine = await start(f)
    t.ok('baseline exists before any invocation', Boolean(await readIntegrity(engine.integrityDir(), 'initial')))
    t.eq('no candidate is invented for the baseline', engine.run.revisions.length, 0)
    await engine.drive()
    t.eq('run completes', engine.run.outcome, 'resolved')
    t.ok('implementer receives write permission', policies.some((p) => p.role === 'implementer' && p.writesCode))
    t.ok('all other roles are read-only', policies.filter((p) => p.role !== 'implementer').every((p) => !p.writesCode))
    const { events } = await readEvents(f.issuePath, engine.runId)
    // Tool-free coordinator turns take no capture of their own; every turn that
    // could reach the worktree does.
    const working = engine.run.steps.filter((x) => !policies.find((p) => p.role === x.role)?.toolFree)
    t.eq('every completed working invocation has an integrity event', events.filter((e) => e.type === 'turn-integrity').length, working.length)
    t.ok('and the tool-free ones are the coordinator\'s', engine.run.steps.filter((x) => !working.includes(x)).every((x) => x.role === 'coordinator'))
    await releaseWorkspace(engine)
  }

  t.section('a quota exhaustion that integrity quarantines still reaches the availability store')
  {
    const calls = []
    const availability = { recordExhausted: async (x) => { calls.push(x); return { modelId: x.modelId, until: 'later' } } }
    const { engine } = await changedTurn({ role: 'implementer', fail: true, availability,
      message: 'claude exited 1', payload: { is_error: true, result: "You've hit your monthly spend limit. Switch to another model to continue.", total_cost_usd: 6.01 },
      change: async (cwd) => { await fs.writeFile(path.join(cwd, 'source.txt'), 'partial') } })
    t.eq('quarantined', engine.run.integrity.status, 'quarantined')
    t.eq('classified from the runtime payload', engine.run.failures.at(-1)?.class, 'quota')
    t.eq('the model is recorded exhausted host-wide', calls.map((c) => c.modelId), [engine.snapshot.participants.implementer.model.id])
    t.eq('the availability record is on the failure', engine.run.failures.at(-1)?.availability?.until, 'later')
    t.eq('the turn\'s cost is on the record', engine.run.failures.at(-1)?.costUsd, 6.01)
    t.eq('persisted', (await readRun(engine.issuePath, engine.runId)).failures.length, 1)
  }

  t.section('successful authors may edit and stage; failed and cancelled authors require disposition')
  for (const mode of ['completed', 'failed', 'cancelled']) {
    const { f, engine } = await changedTurn({ role: 'implementer', fail: mode === 'failed', abort: mode === 'cancelled',
      change: async (cwd) => { await fs.writeFile(path.join(cwd, 'source.txt'), 'useful partial work'); await git(cwd, ['add', 'source.txt']) } })
    if (mode === 'completed') {
      t.eq('successful author accepted', engine.run.outcome, 'resolved')
      t.ok('candidate recorded', engine.run.revisions.length > 0)
    } else {
      t.eq(`${mode}: quarantine`, engine.run.integrity.status, 'quarantined')
      t.eq('failed work did not become a candidate', engine.run.revisions.length, 0)
      t.eq('outcome recorded', engine.run.integrity.latest.outcome, mode)
      if (mode === 'failed') {
        t.eq('the quarantined attempt is on the failure record', engine.run.failures.map((x) => `${x.class}:${x.quarantined}:${x.retried}`), ['runtime:true:false'])
        t.eq('and names the cause of the recovery', engine.run.recovery?.cause?.message, 'simulated failed turn')
      } else t.eq('a cancellation is not a failure', engine.run.failures.length, 0)
      await simulateProcessDeath(f.issuePath)
      const resumed = await resumeRun({ issuePath: f.issuePath, runId: engine.runId, harnesses: f.harnesses, stepStore: f.stepStore, clock: f.clock, configRoot: f.configRoot, projectPath: f.projectPath, deliveryProvider: f.delivery })
      await resumed.recover()
      t.eq('quarantine survives restart', resumed.run.integrity.status, 'quarantined')
      const current = await captureIntegrity(resumed.run.workspace, { clock: f.clock })
      t.ok('stale disposition rejected', await rejected(() => resumed.resolveIntegrity({ disposition: 'accept-partial', expectedStateHash: 'stale', actor: 'operator', reason: 'inspected' })))
      t.ok('false restoration rejected', await rejected(() => resumed.resolveIntegrity({ disposition: 'restored', expectedStateHash: current.hash, actor: 'operator', reason: 'inspected' })))
      await resumed.resolveIntegrity({ disposition: 'accept-partial', expectedStateHash: current.hash, actor: 'operator', reason: 'retain partial work for author retry' })
      t.eq('explicit acceptance clears quarantine', resumed.run.integrity.status, 'clear')
      t.eq('decision persisted', (await readRun(f.issuePath, engine.runId)).integrity.dispositions.at(-1).actor, 'operator')
      // The retry is a fresh invocation and must still produce a reviewed candidate.
      // Restore the unmodified fake adapter for the retry.
      const script = scriptFor()
      f.fake.invoke = async (args) => ({ response: script({ ...args.meta, prompt: args.prompt }), session: { id: 'recovered-session' }, outcome: 'completed' })
      await resumed.drive()
      t.eq('recovered partial work can complete through normal review', resumed.run.outcome, 'resolved')
      await releaseWorkspace(resumed)
      continue
    }
    await releaseWorkspace(engine)
  }

  t.section('an author whose turn failed on a rotated credential keeps its partial edits and is retried once')
  for (const failures of [1, 2, 'retry-used']) {
    const f = await engineFixture({ playbook: 'implementation' })
    const original = f.fake.invoke
    let failed = 0
    // What the claude adapter throws when another process replaced the shared
    // credential file during the turn (harness/claude.mjs credentialChange).
    f.fake.invoke = async (args) => {
      if (args.meta.stepId === 'implement' && failed < (failures === 'retry-used' ? 2 : failures)) {
        failed++
        // 'retry-used': the first rotation leaves nothing and spends the one retry.
        if (failures !== 'retry-used' || failed === 2) await fs.writeFile(path.join(args.cwd, 'source.txt'), `partial ${failed}`)
        throw Object.assign(new Error('claude exited 1\nauthentication_failed: Failed to authenticate: OAuth session expired and could not be refreshed'), { credentials: { changed: true, how: 'replaced' } })
      }
      return original(args)
    }
    const engine = await start(f)
    let thrown = null
    try { await engine.drive() } catch (error) { thrown = error }
    const first = engine.run.failures[0]
    t.eq(`${failures}: the first failure is a retried transient`, `${first?.class}:${first?.retried}`, 'transient:true')
    if (failures === 'retry-used') {
      t.eq('edits after the one retry was spent are not accepted', engine.run.failures[1]?.partialAccepted ?? null, null)
      t.eq('they quarantine instead', `${engine.run.integrity.status}:${engine.run.blockedReason}`, 'quarantined:recovery-required')
      await releaseWorkspace(engine)
      continue
    }
    t.eq('its partial edits are kept for the retry, not quarantined', first?.partialAccepted?.reason, 'credential-rotated')
    t.eq('naming the kept paths', first?.partialAccepted?.paths, ['source.txt'])
    if (failures === 1) {
      t.eq('the run went on without a person', `${engine.run.integrity.status}:${engine.run.outcome}:${thrown?.message ?? null}`, 'clear:resolved:null')
      t.eq('and the retry started from the partial edits', await fs.readFile(path.join(engine.run.workspace.path, 'source.txt'), 'utf8'), 'partial 1')
      t.ok('the acceptance is on the turn\'s integrity record', (await readEvents(engine.issuePath, engine.runId)).events.some((e) => e.type === 'turn-integrity' && e.partialAccepted?.reason === 'credential-rotated'))
    } else {
      t.eq('a second failure quarantines as any other', `${engine.run.integrity.status}:${engine.run.blockedReason}`, 'quarantined:recovery-required')
      t.eq('and is not retried again', engine.run.failures.at(-1)?.retried, false)
    }
    await releaseWorkspace(engine)
  }

  t.section('unauthorized work must be restored or abandoned, never accepted as partial author work')
  {
    const { engine } = await changedTurn({ change: (cwd) => fs.writeFile(path.join(cwd, 'source.txt'), 'bad') })
    let state = await captureIntegrity(engine.run.workspace, { clock: engine.clock })
    t.ok('cannot adopt an auditor edit', await rejected(() => engine.resolveIntegrity({ disposition: 'accept-partial', expectedStateHash: state.hash, actor: 'operator', reason: 'keep' })))
    await fs.writeFile(path.join(engine.run.workspace.path, 'source.txt'), 'original\n')
    state = await captureIntegrity(engine.run.workspace, { clock: engine.clock })
    await engine.resolveIntegrity({ disposition: 'restored', expectedStateHash: state.hash, actor: 'operator', reason: 'restored original source' })
    t.eq('verified restoration clears quarantine', engine.run.integrity.status, 'clear')
    await releaseWorkspace(engine)
  }

  t.section('offline inspection and explicit abandonment are reviewable and retain work')
  {
    const { f, engine } = await changedTurn({ role: 'implementer', fail: true, change: (cwd) => fs.writeFile(path.join(cwd, 'source.txt'), 'partial') })
    const cli = fileURLToPath(new URL('../server/runtime/integrity-cli.mjs', import.meta.url))
    const inspected = JSON.parse((await exec(process.execPath, [cli, f.issuePath, engine.runId])).stdout)
    t.eq('CLI names changed source', inspected.changes.paths[0].path, 'source.txt')
    await simulateProcessDeath(f.issuePath)
    await exec(process.execPath, [cli, f.issuePath, engine.runId, '--disposition', 'abandon', '--state', inspected.stateHash, '--actor', 'test operator', '--reason', 'preserve for manual investigation'])
    const run = await readRun(f.issuePath, engine.runId)
    t.eq('abandonment recorded', run.integrity.status, 'abandoned')
    t.eq('run cannot continue', run.status, 'failed')
    t.eq('work still on disk', await fs.readFile(path.join(run.workspace.path, 'source.txt'), 'utf8'), 'partial')
    engine.run = run
    await releaseWorkspace(engine)
  }
}
