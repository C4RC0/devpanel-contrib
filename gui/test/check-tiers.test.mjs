import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { engineFixture, scriptFor, blocking } from './fakes/fixture.mjs'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { readEvents, runDir } from '../server/runtime/store.mjs'

export const name = 'check tiers — a smoke beside the reviews, the full drive once after approval, and only the full drive closes; a base drive reused across runs'

const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```'
const revision = (p) => (p.match(/Current revision: (sha256:[a-f0-9]{64})/) ?? [])[1] ?? null

/*
 * `boot` is the smoke tier, `deep` only runs in the full drive. Rounds in
 * `reject` get a blocking finding from the reviewer. `f` reuses a fixture for
 * a second run on the same issue and checkout.
 */
async function scenario ({ boot, deep, reject = new Set(), extra = '', f = null, onRound = null }) {
  // The fixture's harness keeps the script it was made with; a later run on
  // the same fixture reaches its own engine and reviews through `state`.
  const state = f?.state ?? { engine: null, log: [], reject }
  Object.assign(state, { log: [], reject, onRound })
  const script = async (turn) => {
    const { stepId, role, round, prompt } = turn
    if (stepId.startsWith('brief')) return fence({ targetRole: 'worker', prompt: 'Do the work.', windowDecision: 'keep' })
    if (stepId === 'implement') {
      await state.onRound?.(round)
      await fs.writeFile(path.join(state.engine.run.workspace.path, `round-${round}.txt`), 'work\n')
      return fence({ summary: 'Implemented', basedOnRevision: revision(prompt) })
    }
    if (stepId.startsWith('audit-')) {
      state.log.push({ role, round, revision: revision(prompt), checksRunning: Boolean(state.engine.checksInFlight) })
      if (state.reject.has(round)) return fence({ verdict: 'changes-needed', artifactRevision: revision(prompt), findings: [blocking(`${role}-${round}`)], priorFindings: [] })
      return fence({ verdict: 'approved', artifactRevision: revision(prompt), findings: [], priorFindings: [] })
    }
    if (stepId === 'confirm') return fence({ satisfied: true, criteria: [{ id: 'AC1', met: true }], revision: revision(prompt) })
    return scriptFor()(turn)
  }
  if (!f) {
    f = await engineFixture({ playbook: 'implementation', script })
    f.state = state
    await fs.appendFile(path.join(f.configRoot, 'playbooks/implementation.yaml'),
      `\nchecks:\n  requirement: required\n  target:\n    kind: local\n    retryFailed: 0\n${extra}    tiers:\n      smoke: [boot]\n    commands:\n      - id: boot\n        run: ${JSON.stringify(boot)}\n      - id: deep\n        run: ${JSON.stringify(deep)}\n`)
  }
  const runOptions = { participants: { 'auditor-1': { model: 'gpt-6-astra' } } }
  const resolved = await resolvePlaybook('implementation', { root: f.configRoot, runOptions, projectId: 'devpanel-project' })
  if (!resolved.ok) throw new Error(resolved.errors.map((e) => e.message).join('; '))
  const engine = state.engine = await startRun({
    expectConfigHash: resolved.resolved.configHash, playbookId: 'implementation', issue: { ...f.issue, project: 'devpanel-project' },
    issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider,
    configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery, runOptions
  })
  await engine.drive()
  const { events } = await readEvents(f.issuePath, engine.runId)
  return { engine, log: state.log, events, f }
}

const started = (events, tier) => events.filter((e) => e.type === 'checks-started' && e.tier === tier).map((e) => e.revision)

export default async function (t) {
  t.section('a smoke failure returns to the author through the failed-check path; that revision gets no full drive')
  {
    // Fails on the first revision only (round-0.txt without round-1.txt); the base has neither and passes.
    const { engine, events } = await scenario({ boot: 'test ! -f round-0.txt || test -f round-1.txt', deep: 'true' })
    const [first, second] = engine.run.revisions.map((r) => r.fingerprint)
    t.eq('the run completes', engine.run.status, 'completed', `${engine.run.blockedReason}`)
    t.eq('the failed smoke cost one more round, with every reviewer approving', engine.run.revisions.length, 2)
    t.eq('the first revision\'s smoke is on the record as failed', engine.run.checkHistory?.find((h) => h.revision === first && h.tier === 'smoke')?.result, 'failed')
    t.eq('the smoke ran on both revisions', started(events, 'smoke'), [first, second])
    t.eq('the full drive ran once, on the approved second revision', started(events, 'full'), [second])
    await releaseWorkspace(engine)
  }

  t.section('the smoke runs on every revision beside the reviews; the full drive once, after approval')
  {
    const { engine, events, log } = await scenario({ boot: 'true', deep: 'true', reject: new Set([0]) })
    const [first, second] = engine.run.revisions.map((r) => r.fingerprint)
    t.eq('the run completes', engine.run.status, 'completed', `${engine.run.blockedReason}`)
    t.eq('the smoke ran on the rejected revision too', started(events, 'smoke'), [first, second])
    t.eq('the full drive only on the approved one', started(events, 'full'), [second])
    t.ok('every review saw its revision\'s smoke started first', log.every((a) => events.findIndex((e) => e.type === 'checks-started' && e.tier === 'smoke' && e.revision === a.revision) >= 0), JSON.stringify(log))
    const closing = engine.run.checkResults.filter((c) => c.revision === second)
    t.eq('the closing revision holds a smoke and a full result', closing.map((c) => c.tier), ['smoke', 'full'])
    t.eq('closure saw the passing full drive', engine.run.closure?.conditions?.checksSatisfied, true)
    await releaseWorkspace(engine)
  }

  t.section('a passing smoke never stands in for the full drive at closure')
  {
    // The full drive fails on every candidate (it has round-0.txt), never on the base: a new failure.
    const { engine, events } = await scenario({ boot: 'true', deep: 'test ! -f round-0.txt' })
    t.ok('every smoke passed', engine.run.checkHistory.filter((h) => h.tier === 'smoke').every((h) => h.result === 'passed'))
    t.ok('the full drive ran and failed', started(events, 'full').length >= 1 && engine.run.checkHistory.filter((h) => h.tier === 'full').every((h) => h.result === 'failed'))
    t.ok('the run did not complete', engine.run.status !== 'completed', `${engine.run.status} ${engine.run.blockedReason}`)
    t.ok('and nothing closed on the smoke', engine.run.closure?.conditions?.checksSatisfied !== true)
    await releaseWorkspace(engine).catch(() => {})
  }

  t.section('a baseline the run holds is reused for a later revision only while its identity still matches')
  for (const change of [false, true]) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-tier-held-'))
    const counter = path.join(dir, 'base-runs')
    const staged = path.join(dir, 'deployment-scope.json')
    const environment = path.join(dir, 'node')
    await fs.writeFile(staged, '{}\n')
    await fs.writeFile(environment, 'v22.11.0\n')
    const counted = `if ! ls round-*.txt >/dev/null 2>&1; then echo base >> ${counter}; fi; true`
    const extra = `    compareBaseline: true\n    baselineCache:\n      files: [${staged}]\n      environment: "cat ${environment}"\n`
    // Between the first (rejected) revision and the second, staging and the host change, or nothing does.
    const onRound = async (round) => {
      if (round === 1 && change) { await fs.writeFile(staged, '{"changed":true}\n'); await fs.writeFile(environment, 'v22.12.0\n') }
    }
    const { engine } = await scenario({ boot: counted, deep: 'true', reject: new Set([0]), extra, onRound })
    const [first, second] = engine.run.revisions.map((r) => r.fingerprint)
    t.eq(`${change ? 'changed' : 'unchanged'}: the run completes`, engine.run.status, 'completed', `${engine.run.blockedReason}`)
    const bases = (await fs.readFile(counter, 'utf8')).split('\n').filter(Boolean).length
    const smokeOf = (revision) => engine.run.checkResults.find((c) => c.revision === revision && c.tier === 'smoke')
    // The first baseline is the smoke tier's (the full drive comes after approval); same tier, same target key.
    const smokeBases = engine.run.baselineChecks.filter((b) => b.targetKey === engine.run.baselineChecks[0]?.targetKey)
    if (change) {
      // smoke base for the first revision, a fresh one for the second, and the full drive's.
      t.eq('changed: the second revision got a fresh smoke base drive', bases, 3)
      t.ok('changed: the two smoke baselines were taken under different identities', smokeBases.length === 2 && smokeBases[0].identityKey !== smokeBases[1].identityKey && Boolean(smokeBases[1].identityKey), JSON.stringify(engine.run.baselineChecks.map((b) => [b.dir, b.identityKey])))
      t.ok('changed: each kept its own directory', smokeBases.length === 2 && smokeBases[0].dir !== smokeBases[1].dir)
      const latest = smokeOf(second)
      t.ok('changed: the second revision was compared with the fresh baseline, not the old one', !latest || latest.baselineComparison?.baselineDir === smokeBases[1]?.dir, JSON.stringify(latest?.baselineComparison?.baselineDir))
    } else {
      // smoke base once (reused by the second revision), and the full drive's.
      t.eq('unchanged: the held smoke baseline served both revisions', bases, 2)
    }
    t.ok(`${change ? 'changed' : 'unchanged'}: two revisions were checked`, Boolean(first && second))
    await releaseWorkspace(engine)
    await fs.rm(dir, { recursive: true, force: true })
  }

  t.section('a base drive whose identity changed or could not be read during it is never reused')
  for (const fault of ['changed', 'unreadable']) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-tier-unstable-'))
    const counter = path.join(dir, 'base-runs')
    const staged = path.join(dir, 'deployment-scope.json')
    const environment = path.join(dir, 'node')
    const once = path.join(dir, 'faulted')
    await fs.writeFile(staged, '{"staging":"A"}\n')
    await fs.writeFile(environment, 'v22.11.0\n')
    // The first base drive changes the staging file (or removes the environment's
    // source) while it runs; the identity read after it then differs (or fails).
    const disturb = fault === 'changed' ? `echo '{"staging":"B"}' > ${staged}` : `rm -f ${environment}`
    // Each base drive prints its own number, so its log shows which drive wrote it.
    const boot = `if ! ls round-*.txt >/dev/null 2>&1; then echo base >> ${counter}; echo "base drive $(wc -l < ${counter})"; if [ ! -e ${once} ]; then touch ${once}; ${disturb}; fi; fi; true`
    const extra = `    compareBaseline: true\n    baselineCache:\n      files: [${staged}]\n      environment: "cat ${environment}"\n`
    // Before the next revision the original identity is back, exactly as it was before that drive.
    const onRound = async (round) => {
      if (round === 1) { await fs.writeFile(staged, '{"staging":"A"}\n'); await fs.writeFile(environment, 'v22.11.0\n') }
    }
    const { engine } = await scenario({ boot, deep: 'true', reject: new Set([0]), extra, onRound })
    const [, second] = engine.run.revisions.map((r) => r.fingerprint)
    t.eq(`${fault}: the run completes`, engine.run.status, 'completed', `${engine.run.blockedReason}`)
    const smokeBases = engine.run.baselineChecks.filter((b) => b.targetKey === engine.run.baselineChecks[0]?.targetKey)
    const [disturbed, fresh] = smokeBases
    t.eq(`${fault}: the disturbed drive is recorded as such`, disturbed?.cache?.state, fault === 'changed' ? 'unstable' : 'unavailable', JSON.stringify(disturbed?.cache))
    t.eq(`${fault}: and vouches for no identity`, disturbed?.identityKey, undefined)
    // first revision's smoke base, a fresh one for the second, the full drive's base.
    t.eq(`${fault}: the second revision did not reuse it: a fresh base drive ran`, (await fs.readFile(counter, 'utf8')).split('\n').filter(Boolean).length, 3)
    t.ok(`${fault}: the fresh baseline stands for the restored identity, in a directory of its own`, Boolean(fresh?.identityKey) && Boolean(disturbed?.dir) && fresh.dir !== disturbed.dir, JSON.stringify(smokeBases.map((b) => [b.dir, b.identityKey, b.cache?.state])))
    const logOf = (b) => fs.readFile(path.join(runDir(engine.issuePath, engine.runId), b?.dir ?? 'missing', 'boot.stdout'), 'utf8').catch((e) => e.code)
    t.eq(`${fault}: the disturbed baseline's log is still the disturbed drive's own`, (await logOf(disturbed)).trim(), 'base drive 1')
    t.eq(`${fault}: the fresh drive wrote its own log`, (await logOf(fresh)).trim(), 'base drive 2')
    const latest = engine.run.checkResults.find((c) => c.revision === second && c.tier === 'smoke')
    t.ok(`${fault}: the second revision was compared with the fresh baseline`, latest?.baselineComparison?.baselineDir === fresh?.dir, JSON.stringify(latest?.baselineComparison?.baselineDir))
    await releaseWorkspace(engine)
    await fs.rm(dir, { recursive: true, force: true })
  }

  t.section('the base drive of each tier is reused by the next run on the same base commit, and the run says so')
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-tier-cache-'))
    const counter = path.join(dir, 'base-runs')
    const staged = path.join(dir, 'deployment-scope.json')
    await fs.writeFile(staged, '{}\n')
    // Each command counts its runs on the base (no round file there).
    const counted = (id) => `if ! ls round-*.txt >/dev/null 2>&1; then echo ${id} >> ${counter}; fi; true`
    const extra = `    compareBaseline: true\n    baselineCache:\n      files: [${staged}]\n      environment: "echo node-v22"\n`
    const one = await scenario({ boot: counted('boot'), deep: counted('deep'), extra })
    t.eq('the first run completes', one.engine.run.status, 'completed', `${one.engine.run.blockedReason}`)
    const baseRuns = (await fs.readFile(counter, 'utf8')).split('\n').filter(Boolean).length
    t.ok('it drove the base of both tiers', baseRuns >= 3, String(baseRuns))
    t.eq('and stored both', one.engine.run.baselineChecks.map((b) => b.cache?.state), ['stored', 'stored'])
    await releaseWorkspace(one.engine)
    const entries = (await fs.readdir(path.join(path.dirname(one.f.issuePath), '.baselines'))).filter((n) => !n.startsWith('.'))
    t.eq('under issues/<project>/.baselines', entries.length, 2)

    const two = await scenario({ boot: counted('boot'), deep: counted('deep'), f: one.f })
    t.eq('the second run completes', two.engine.run.status, 'completed', `${two.engine.run.blockedReason}`)
    t.eq('on the same base commit', two.engine.run.workspace.baseCommit, one.engine.run.workspace.baseCommit)
    t.eq('no base command ran again', (await fs.readFile(counter, 'utf8')).split('\n').filter(Boolean).length, baseRuns)
    t.ok('every baseline it used was reused from the first run', two.engine.run.baselineChecks.length === 2 && two.engine.run.baselineChecks.every((b) => b.reused?.fromRun === one.engine.runId), JSON.stringify(two.engine.run.baselineChecks.map((b) => b.reused ?? b.cache)))
    t.ok('the comparison names the reuse for reviewers', two.engine.run.checkResults.every((c) => c.baselineComparison?.reused?.fromRun === one.engine.runId))
    await releaseWorkspace(two.engine)

    await fs.writeFile(staged, '{"changed":true}\n')
    const three = await scenario({ boot: counted('boot'), deep: counted('deep'), f: one.f })
    t.ok('a changed staging file is a miss: the base runs again', (await fs.readFile(counter, 'utf8')).split('\n').filter(Boolean).length > baseRuns)
    t.ok('and nothing is marked reused', three.engine.run.baselineChecks.every((b) => !b.reused))
    await releaseWorkspace(three.engine)
    await fs.rm(dir, { recursive: true, force: true })
  }
}
