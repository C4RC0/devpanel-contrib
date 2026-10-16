import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { startRun, releaseWorkspace, gitWorktreeProvider } from '../server/runtime/launch.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { readEvents } from '../server/runtime/store.mjs'
import { ProcessError, alive } from '../server/runtime/process.mjs'
import { runChecks } from '../server/runtime/checks.mjs'
import { baselineOf, fingerprint } from '../server/runtime/fingerprint.mjs'
import { hostPlatform, platformFor, REAP_TAG } from '../server/runtime/platform.mjs'
import { workspaceDisposition, supportedActions } from '../server/supervisor.mjs'
import { engineFixture, scriptFor, cleanupFixtures } from './fakes/fixture.mjs'

/*
 * What the engine does with a turn's descendant scan (P3-2, P3-3): it is
 * recorded on the step, a scan that is not complete leaves an open cleanup
 * entry, and nothing hands the workspace to another writer — no next turn, no
 * retry, no replacement model, no resume — until the cleanup is proved or a
 * person acknowledges it. The fake runtime reports the scans; the proofs scan
 * through an injected platform, or this host's real one where it reaps.
 */
const run = promisify(execFile)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```'
const revision = (p) => (p.match(/Current revision: (sha256:[a-f0-9]{64})/) ?? [])[1] ?? null
const scan = (status, extra = {}) => ({ status, method: 'proc-environ', tag: crypto.randomUUID(), escaped: 0, ...(status === 'complete' ? {} : { reason: `${status} for the test` }), ...extra })
const withReap = (stepId, reap, base = scriptFor()) => (turn) => turn.stepId === stepId ? { text: base(turn), diagnostics: { reap } } : base(turn)
const kept = (r) => workspaceDisposition(r, { unchanged: true, proven: true }).discard === false
const eventsOf = async (f, engine) => (await readEvents(f.issuePath, engine.runId)).events
const proving = (answers) => ({ ...hostPlatform(), descendantScan: { proved: true }, taggedProcesses: async () => answers.shift() ?? { status: 'complete', method: 'test', pids: [] } })

export default async function (t) {
  t.section('1. a complete scan is recorded on the step and the run goes on')
  {
    const reap = scan('complete')
    const f = await engineFixture({ script: withReap('implement', reap) })
    const engine = await startRun({ ...f, deliveryProvider: f.delivery })
    await engine.drive()
    t.eq('the run completes', engine.run.status, 'completed', engine.run.blockedReason)
    t.eq('the implement step carries its scan', engine.run.steps.find((s) => s.stepId === 'implement')?.reap, reap)
    t.eq('no cleanup entry', engine.run.cleanup, undefined)
    t.eq('the run names this host and what it cannot do (P1-4)', engine.run.host, hostPlatform().describe())
    await releaseWorkspace(engine)
  }

  for (const status of ['unavailable', 'incomplete']) {
    t.section(`2. an ${status} scan is recorded as such, and the run hands nothing on`)
    const reap = scan(status, status === 'incomplete' ? { method: 'ps-E', notInspected: [9] } : {})
    const f = await engineFixture({ script: withReap('implement', reap) })
    const engine = await startRun({ ...f, deliveryProvider: f.delivery })
    const r = await engine.drive()
    t.eq(`${status}: blocked cleanup-unproved`, `${r.status}/${r.blockedReason}`, 'blocked/cleanup-unproved')
    t.eq(`${status}: the step keeps the scan as it was`, r.steps.find((s) => s.stepId === 'implement')?.reap?.status, status)
    t.eq(`${status}: an open entry names the turn and its tag`, [r.cleanup?.entries?.[0]?.reason, r.cleanup?.entries?.[0]?.tag, r.cleanup?.entries?.[0]?.role], [`scan-${status}`, reap.tag, 'implementer'])
    t.eq(`${status}: no later turn ran`, r.steps.map((s) => s.stepId).at(-1), 'implement')
    t.ok(`${status}: the workspace is retained`, kept(r))
    t.eq(`${status}: offered to prove, acknowledge or resume`, supportedActions(r).slice(0, 2), ['prove-cleanup', 'acknowledge-cleanup'])
    if (status === 'unavailable') {
      t.section('6. resume proves the cleanup first: a clean scan lets the run go on')
      engine.platform = proving([])
      await engine.resumeExecution()
      t.ok('the entry is proved', Boolean(engine.run.cleanup.entries[0].provedAt))
      const done = await engine.drive()
      t.eq('and the run completes', done.status, 'completed', done.blockedReason)
    } else {
      t.section('7. a proof that fails keeps the run blocked and invokes nobody')
      const before = r.steps.length
      engine.platform = proving([{ status: 'unavailable', method: 'test', pids: [], reason: 'nope' }])
      const refused = await engine.resumeExecution().catch((e) => e)
      t.eq('refused', [refused.status, refused.code], [409, 'CLEANUP_UNPROVED'])
      t.eq('still blocked', `${engine.run.status}/${engine.run.blockedReason}`, 'blocked/cleanup-unproved')
      t.ok('the attempt is on record', (await eventsOf(f, engine)).some((e) => e.type === 'cleanup-still-unproved'))
      t.eq('no turn ran', engine.run.steps.length, before)
    }
    await releaseWorkspace(engine)
  }

  t.section('6b. a survivor carrying the tag is terminated, then the tag is scanned again')
  if (process.platform !== 'linux') t.skip('the real linux scan', 'not linux')
  else {
    const reap = scan('unavailable')
    const f = await engineFixture({ script: withReap('implement', reap) })
    const engine = await startRun({ ...f, deliveryProvider: f.delivery })
    await engine.drive()
    const survivor = spawn('sleep', ['30'], { env: { ...process.env, [REAP_TAG]: reap.tag }, stdio: 'ignore' })
    await new Promise((resolve) => survivor.once('spawn', resolve))
    engine.platform = platformFor('linux')
    await engine.resumeExecution()
    const attempt = engine.run.cleanup.entries[0].attempts.at(-1)
    t.eq('the survivor was terminated and the rescan found nothing', [attempt.terminated, attempt.survivors, attempt.status], [[survivor.pid], [], 'complete'])
    t.eq('and it is gone', alive(survivor.pid), false)
    await engine.drive()
    await releaseWorkspace(engine)
  }

  t.section('3. a retryable failure with an unavailable scan is not retried')
  {
    const f = await engineFixture()
    let calls = 0
    const invoke = async (args) => {
      if (args.meta.stepId !== 'implement') return f.fake.invoke(args)
      calls++
      throw new ProcessError('claude exited 1', { kind: 'runtime-error', code: 1, stderr: 'API Error: 429 Too Many Requests', invocationId: args.meta.invocationId, reap: scan('unavailable') })
    }
    const engine = await startRun({ ...f, deliveryProvider: f.delivery, harnesses: { fake: { ...f.fake, invoke } } })
    const r = await engine.drive()
    t.eq('one attempt only', calls, 1)
    t.eq('classified as a rate limit, and marked', [r.failures.at(-1).class, r.failures.at(-1).retried, r.failures.at(-1).cleanupUnproved], ['rate-limit', false, true])
    t.ok('no retry was scheduled', !(await eventsOf(f, engine)).some((e) => e.type === 'invocation-retry'))
    t.eq('blocked, not failed', `${r.status}/${r.blockedReason}`, 'blocked/cleanup-unproved')
    await releaseWorkspace(engine)
  }

  t.section('4. a quota failure with an incomplete scan gets no replacement model')
  {
    const f = await engineFixture()
    const invoke = async (args) => {
      if (args.meta.stepId !== 'implement') return f.fake.invoke(args)
      throw new ProcessError('codex exited 1', { kind: 'runtime-error', code: 1, stderr: 'insufficient_quota', invocationId: args.meta.invocationId, reap: scan('incomplete', { method: 'ps-E' }) })
    }
    const engine = await startRun({ ...f, deliveryProvider: f.delivery, harnesses: { fake: { ...f.fake, invoke } } })
    let fallbacks = 0
    const recorded = []
    engine.quotaFallback = async () => { fallbacks++; return null }
    engine.availability = { recordExhausted: async (a) => { recorded.push(a.modelId); return { recorded: true } } }
    const r = await engine.drive()
    t.eq('the fallback was never asked', fallbacks, 0)
    t.eq('the exhausted model is still recorded host-wide', recorded.length, 1)
    t.ok('nothing was substituted', !(await eventsOf(f, engine)).some((e) => e.type === 'model-substituted'))
    t.eq('blocked cleanup-unproved', `${r.status}/${r.blockedReason}`, 'blocked/cleanup-unproved')
    await releaseWorkspace(engine)
  }

  t.section('5. a cancel whose scan was not proved says so and keeps the workspace')
  {
    const f = await engineFixture()
    let engine = null
    const reap = scan('unavailable')
    const invoke = async (args) => {
      if (args.meta.stepId !== 'implement') return f.fake.invoke(args)
      engine.controller.abort()
      throw Object.assign(new Error('cancelled'), { name: 'AbortError', termination: { method: 'SIGTERM', confirmedAt: Date.now(), descendants: 'unavailable', complete: false }, reap })
    }
    engine = await startRun({ ...f, deliveryProvider: f.delivery, harnesses: { fake: { ...f.fake, invoke } } })
    const r = await engine.drive()
    t.eq('cancelled', r.status, 'cancelled')
    t.eq('the cancel event carries the unproved cleanup', (await eventsOf(f, engine)).find((e) => e.type === 'cancelled')?.cleanup, 'unavailable')
    t.eq('an open entry remains', r.cleanup?.entries?.[0]?.tag, reap.tag)
    t.ok('the workspace is retained', kept(r))
    const live = await readLiveExit(f, engine)
    t.ok('the live log does not claim complete termination', /could not be proved gone/.test(live), live)
    await releaseWorkspace(engine)
  }

  t.section('8a. cleanup-unproved wins over the coordinator\'s operator request on the same turn')
  {
    const request = { question: 'Commit the checkout?', reason: 'needed', category: 'live-checkout', recommendation: 'Commit it.' }
    const f = await engineFixture({ script: withReap('brief-implement', scan('unavailable'), scriptFor({ operatorRequest: { stepId: 'brief-implement', request } })) })
    const engine = await startRun({ ...f, deliveryProvider: f.delivery })
    const r = await engine.drive()
    t.eq('blocked, not paused', `${r.status}/${r.blockedReason}`, 'blocked/cleanup-unproved')
    t.eq('no pause was opened', r.pause ?? null, null)
    t.eq('nothing ran after the turn', r.steps.map((s) => s.stepId).join(','), 'triage,brief-implement')
    await releaseWorkspace(engine)
  }

  t.section('8b. a concurrent reviewer settles, then nothing else starts')
  {
    const seats = { participants: { 'auditor-1': { model: 'gpt-6-astra' }, 'auditor-2': { model: 'gpt-6-astra' } } }
    const script = async (turn) => {
      const { stepId, prompt } = turn
      if (stepId === 'audit-implement-1') return { text: fence({ verdict: 'approved', artifactRevision: revision(prompt), findings: [], priorFindings: [] }), diagnostics: { reap: scan('unavailable') } }
      if (stepId === 'audit-implement-2') { await sleep(200); return fence({ verdict: 'approved', artifactRevision: revision(prompt), findings: [], priorFindings: [] }) }
      return scriptFor()(turn)
    }
    const f = await engineFixture({ script })
    const engine = await startRun({ ...f, deliveryProvider: f.delivery, runOptions: seats,
      expectConfigHash: (await resolvePlaybook(f.playbookId, { root: f.configRoot, runOptions: seats, projectId: 'devpanel-project' })).resolved.configHash })
    const r = await engine.drive()
    t.eq('both reviews of the round were recorded', r.steps.filter((s) => s.stepId.startsWith('audit-implement')).length, 2)
    t.eq('blocked cleanup-unproved', `${r.status}/${r.blockedReason}`, 'blocked/cleanup-unproved')
    t.eq('no confirmation turn, no delivery', [r.steps.some((s) => s.stepId === 'confirm'), r.delivery ?? null], [false, null])
    await releaseWorkspace(engine)
  }

  t.section('9. a check record says no descendant scan was requested (checks are not reaped)')
  {
    const temp = async (p) => fs.mkdtemp(path.join(os.tmpdir(), p))
    const projectPath = await temp('reap-check-proj-')
    await run('git', ['-C', projectPath, 'init', '-q', '-b', 'main'])
    await run('git', ['-C', projectPath, 'config', 'user.email', 't@example.invalid'])
    await run('git', ['-C', projectPath, 'config', 'user.name', 'T'])
    await fs.writeFile(path.join(projectPath, 'value.txt'), '1\n')
    await run('git', ['-C', projectPath, 'add', '-A'])
    await run('git', ['-C', projectPath, 'commit', '-qm', 'base'])
    const ws = await gitWorktreeProvider.create({ projectPath, runId: 'reap', root: await temp('reap-check-ws-'), policy: { base: 'head' } })
    const baseline = await baselineOf(ws.path)
    await fs.writeFile(path.join(ws.path, 'value.txt'), '2\n')
    const fp = await fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline })
    const result = await runChecks({ target: { kind: 'local', commands: [{ id: 'value', run: 'true' }] }, revision: fp.fingerprint, fingerprint: fp, baseCommit: ws.baseCommit, baseline, workspacePath: ws.path, runDir: await temp('reap-check-run-') })
    t.eq('the command record names the scan as not requested', result.commands[0]?.descendants, { status: 'not-requested' })
    await fs.rm(projectPath, { recursive: true, force: true })
  }

  t.section('11. the reap tag is persisted on the pending invocation before the runtime is called')
  {
    const f = await engineFixture()
    let seen = null
    let engine = null
    const invoke = async (args) => {
      if (args.meta.stepId === 'implement') {
        const persisted = JSON.parse(await fs.readFile(path.join(f.issuePath, 'runs', engine.runId, 'run.json'), 'utf8'))
        seen = { persisted: persisted.participants.implementer.pendingInvocation?.reapTag ?? null, given: args.meta.reapTag ?? null }
      }
      return f.fake.invoke(args)
    }
    engine = await startRun({ ...f, deliveryProvider: f.delivery, harnesses: { fake: { ...f.fake, invoke } } })
    await engine.drive()
    t.ok('a tag was handed to the runtime', /^[0-9a-f-]{36}$/.test(seen?.given ?? ''), JSON.stringify(seen))
    t.eq('and was on disk before the call', seen?.persisted, seen?.given)
    await releaseWorkspace(engine)
  }

  await cleanupFixtures()
}

/** The text of the last `exit` entry of the implement invocation's live log. */
async function readLiveExit (f, engine) {
  const dir = path.join(f.issuePath, 'runs', engine.runId, 'live')
  const texts = []
  for (const name of await fs.readdir(dir).catch(() => [])) {
    for (const line of (await fs.readFile(path.join(dir, name), 'utf8')).split('\n').filter(Boolean)) {
      const entry = JSON.parse(line)
      if (entry.kind === 'exit') texts.push(entry.text)
    }
  }
  return texts.join(' | ')
}
