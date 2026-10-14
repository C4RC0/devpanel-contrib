import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'

import { startRun, discardWorkspace, releaseWorkspace, inPlaceProvider, workspaceUnchanged } from '../server/runtime/launch.mjs'
import { readBaseline } from '../server/runtime/store.mjs'
import { fingerprint } from '../server/runtime/fingerprint.mjs'
import { runOptionErrors, applyRunOptions } from '../server/config/run-options.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { previewRun } from '../server/runtime/preview.mjs'
import { supportedActions, workspaceDisposition } from '../server/supervisor.mjs'
import { engineFixture, cleanupFixtures } from './fakes/fixture.mjs'
import { listen } from './helpers.mjs'

export const name = 'in place — a run may work directly in the project checkout instead of a worktree'

const NL = String.fromCharCode(10)
const start = (f, extra = {}) => startRun({ ...f, issue: { project: 'devpanel-project', id: f.issue.id }, deliveryProvider: f.delivery, ...extra })
const exists = (p) => fs.access(p).then(() => true, () => false)

export default async function (t) {
  try {
    t.section('1. the option is a per-run argument, and only the two modes are accepted')
    t.eq('in-place accepted', runOptionErrors({ isolation: 'in-place' }), [])
    t.eq('git-worktree accepted', runOptionErrors({ isolation: 'git-worktree' }), [])
    t.ok('anything else rejected', runOptionErrors({ isolation: 'live' }).length > 0)
    t.eq('applied to the playbook workspace', applyRunOptions({ workspace: { base: 'head' } }, { isolation: 'in-place' }).workspace, { base: 'head', isolation: 'in-place' })

    t.section('2. resolution and preview say where the work will happen')
    let f = await engineFixture()
    const r = await resolvePlaybook(f.playbookId, { root: f.configRoot, runOptions: { isolation: 'in-place' } })
    t.ok('resolves', r.ok, JSON.stringify(r.errors))
    t.eq('isolation chosen by the run', `${r.resolved.workspace.isolation}/${r.resolved.workspace.isolationSource}`, 'in-place/run')
    t.ok('the choice is in the hash', r.resolved.configHash !== (await resolvePlaybook(f.playbookId, { root: f.configRoot })).resolved.configHash)
    const preview = await previewRun({ playbookId: f.playbookId, configRoot: f.configRoot, runOptions: { isolation: 'in-place' }, deliveryActions: ['worktree-diff'] })
    t.ok('the preview warns about live edits', preview.prerequisites.some((p) => p.kind === 'in-place-workspace' && /live tree/.test(p.detail)))
    t.ok('and does not promise a patch', !preview.prerequisites.some((p) => p.kind === 'delivery-provider'))

    t.section('3. the workspace is the project checkout; the work lands there and nothing is handed off')
    const original = f.fake.invoke
    const coordinatorInstructions = []
    f.fake.invoke = async (args) => {
      if (args.meta.role === 'coordinator') coordinatorInstructions.push(`${args.instructions ?? ''}${NL}${args.prompt ?? ''}`)
      if (args.meta.stepId === 'implement') await fs.writeFile(path.join(args.cwd, 'source.txt'), 'edited in place' + NL)
      return original(args)
    }
    let engine = await start(f, { runOptions: { isolation: 'in-place' }, expectConfigHash: r.resolved.configHash })
    const projectPath = await fs.realpath(f.projectPath)
    t.eq('isolation recorded', engine.run.workspace.isolation, 'in-place')
    t.eq('the workspace is the checkout', engine.run.workspace.path, projectPath)
    t.eq('no base commit', engine.run.workspace.baseCommit, null)
    t.eq('the base policy says so', engine.run.workspace.base.policy, 'in-place')
    t.ok('the checkout\'s head is on record', /^[0-9a-f]{40}$/.test(engine.run.workspace.base.headCommit ?? ''))
    t.ok('no worktree was created', !(await fs.readdir(path.join(f.issuePath, 'runs'))).some((d) => d.startsWith('worktree-')))
    t.eq('the live checkout is allowed to every seat', engine.toolingPolicy('implementer').allowLiveCheckout, true)
    t.ok('scratch stays outside the checkout', !engine.run.workspace.scratchPath.startsWith(projectPath + path.sep))
    await engine.drive()
    t.eq('completed', engine.run.status, 'completed')
    t.eq('resolved', engine.run.outcome, 'resolved')
    t.eq('delivered in place', engine.run.delivery.action, 'in-place')
    t.ok('with a completion time', Boolean(engine.run.delivery.completedAt))
    t.eq('naming the checkout', engine.run.delivery.path, projectPath)
    t.eq('and what changed', engine.run.delivery.changedPaths, ['source.txt'])
    t.eq('the edit is in the project', await fs.readFile(path.join(projectPath, 'source.txt'), 'utf8'), 'edited in place' + NL)
    t.eq('no patch provider was called', f.delivery.calls.length, 0)
    t.ok('the revision is fingerprinted', engine.run.revisions.length > 0 && engine.run.closure.revision === engine.run.revisions.at(-1).fingerprint)
    t.eq('closure conditions all hold', Object.values(engine.run.closure.conditions).every(Boolean), true, JSON.stringify(engine.run.closure.conditions))
    t.eq('only a fresh start is offered afterwards', supportedActions(engine.run), ['start-new'])
    t.ok('the coordinator is told the checkout is the candidate', coordinatorInstructions.some((text) => /works directly in the project's live checkout/.test(text)))
    t.ok('and never that no one may touch it', !coordinatorInstructions.some((text) => /No participant may touch the project's live checkout/.test(text)))
    t.ok('while commits and HEAD moves stay forbidden', coordinatorInstructions.some((text) => /may commit, push, or move Git HEAD/.test(text)))

    t.section('3b. a change to nothing but the executable bit is still a change, and is reported')
    {
      const g = await engineFixture()
      const first = g.fake.invoke
      g.fake.invoke = async (args) => {
        if (args.meta.stepId === 'implement') await fs.chmod(path.join(args.cwd, 'source.txt'), 0o755)
        return first(args)
      }
      const hash = (await resolvePlaybook(g.playbookId, { root: g.configRoot, runOptions: { isolation: 'in-place' } })).resolved.configHash
      const modeRun = await start(g, { runOptions: { isolation: 'in-place' }, expectConfigHash: hash })
      await modeRun.drive()
      t.eq('completed', modeRun.run.status, 'completed')
      t.eq('the mode change is the changed path', modeRun.run.delivery.changedPaths, ['source.txt'])
      t.eq('and the fingerprint calls it modified', modeRun.run.closure.revision !== null && (await fs.stat(path.join(g.projectPath, 'source.txt'))).mode & 0o100 ? 'executable' : 'not', 'executable')
      await releaseWorkspace(modeRun)
    }

    t.section('3b2. the project\'s excludes hold in place: runtime sockets and live state are not source')
    {
      // An application's live checkout: its runtime/ holds IPC sockets, and the strict
      // integrity walk failed the run on the first one ("unsupported source entry").
      const g = await engineFixture()
      const file = path.join(g.configRoot, 'playbooks', `${g.playbookId}.yaml`)
      await fs.appendFile(file, `workspace:${NL}  excludes:${NL}    - runtime${NL}`)
      await fs.mkdir(path.join(g.projectPath, 'runtime'))
      const server = net.createServer()
      // EPERM: a seat whose own sandbox refuses sockets (Unix ones too) cannot hold one here.
      const listening = await listen(server, path.join(g.projectPath, 'runtime', 'ipc.socket')).then(() => true, (error) => { if (error.code !== 'EPERM') throw error; return false })
      if (!listening) t.skip('a run beside a runtime socket', 'this environment refuses a Unix socket listener (EPERM)')
      else {
        const first = g.fake.invoke
        g.fake.invoke = async (args) => {
          // The running application keeps writing its state during every turn.
          await fs.appendFile(path.join(g.projectPath, 'runtime', 'app.log'), `${args.meta.stepId}${NL}`)
          if (args.meta.stepId === 'implement') await fs.writeFile(path.join(args.cwd, 'source.txt'), 'edited beside a socket' + NL)
          return first(args)
        }
        try {
          const hash = (await resolvePlaybook(g.playbookId, { root: g.configRoot, runOptions: { isolation: 'in-place' } })).resolved.configHash
          const live = await start(g, { runOptions: { isolation: 'in-place' }, expectConfigHash: hash })
          t.eq('the excludes are on the workspace record', live.run.workspace.base.excludes, ['runtime'])
          await live.drive()
          t.eq('completed', `${live.run.status}/${live.run.outcome}`, 'completed/resolved', JSON.stringify(live.run.failure ?? live.run.integrity))
          t.eq('only the source change is delivered', live.run.delivery?.changedPaths, ['source.txt'])
        } finally {
          server.close()
        }
      }
    }

    t.section('3c. in-place work cannot start under a playbook that requires checks')
    {
      // Strengthen the sandbox copy's check requirement, as a playbook may.
      const file = path.join(f.configRoot, 'playbooks', `${f.playbookId}.yaml`)
      await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace(/^autoClose:$/m, `checks:${NL}  requirement: required${NL}autoClose:`))
      const refused = await resolvePlaybook(f.playbookId, { root: f.configRoot, runOptions: { isolation: 'in-place' } })
      t.eq('refused at resolution', refused.ok, false)
      t.ok('with the reason', refused.errors.some((e) => /required checks/.test(e.message)))
      const worktree = await resolvePlaybook(f.playbookId, { root: f.configRoot })
      t.eq('the same playbook resolves in a worktree', worktree.ok, true, JSON.stringify(worktree.errors))
    }

    t.section('4. the checkout is never removed, whatever disposal decides')
    t.eq('disposal refuses', workspaceDisposition(engine.run, { unchanged: false, proven: true, reason: 'edited' }).discard, false)
    await discardWorkspace(engine)
    t.ok('the project is still there', await exists(path.join(projectPath, 'source.txt')))
    t.eq('recorded as retained', engine.run.workspace.state, 'retained')
    await releaseWorkspace(engine)
    t.ok('and still there after release', await exists(path.join(projectPath, 'source.txt')))
    await inPlaceProvider.release({ projectPath, path: projectPath })
    t.ok('the provider itself deletes nothing', await exists(projectPath))

    t.section('5. a writer that fails mid-turn leaves the live tree quarantined, and the tree is kept')
    f = await engineFixture()
    const before = await fs.readFile(path.join(f.projectPath, 'source.txt'), 'utf8')
    const orig = f.fake.invoke
    f.fake.invoke = async (args) => {
      if (args.meta.stepId === 'implement') {
        await fs.writeFile(path.join(args.cwd, 'source.txt'), 'half done' + NL)
        throw new Error('simulated crash while editing the live tree')
      }
      return orig(args)
    }
    const hash = (await resolvePlaybook(f.playbookId, { root: f.configRoot, runOptions: { isolation: 'in-place' } })).resolved.configHash
    engine = await start(f, { runOptions: { isolation: 'in-place' }, expectConfigHash: hash })
    await engine.drive()
    t.eq('quarantined', engine.run.integrity.status, 'quarantined')
    t.eq('blocked for recovery', engine.run.blockedReason, 'recovery-required')
    t.eq('the partial edit is in the live tree, on record', await fs.readFile(path.join(f.projectPath, 'source.txt'), 'utf8'), 'half done' + NL)
    t.ok('it differs from what the run started with', before !== 'half done' + NL)
    t.eq('the attempt is a recorded failure', engine.run.failures.at(-1)?.quarantined, true)
    await releaseWorkspace(engine)
    t.ok('the checkout survives the teardown', await exists(path.join(f.projectPath, 'source.txt')))

    t.section('6. an unreadable mode baseline never licenses disposal; only an absent one is legacy')
    {
      const g = await engineFixture()
      const run = await start(g)
      await run.drive()
      t.eq('a worktree run completed', run.run.status, 'completed')
      const dir = path.join(g.issuePath, 'runs', run.runId)
      await fs.chmod(path.join(run.run.workspace.path, 'source.txt'), 0o755)
      run.baseline = null
      const valid = await workspaceUnchanged(run)
      t.eq('a valid sidecar sees the mode change', `${valid.unchanged}/${valid.proven}`, 'false/true')
      await fs.writeFile(path.join(dir, 'baseline-modes.json'), '{ not json')
      run.baseline = null
      const corrupt = await workspaceUnchanged(run)
      t.eq('a corrupt sidecar proves nothing', `${corrupt.unchanged}/${corrupt.proven}`, 'false/false')
      t.ok('and says why', /could not be read/.test(corrupt.reason))
      t.eq('so disposal refuses', workspaceDisposition(run.run, corrupt).discard, false)
      const stored = await readBaseline(g.issuePath, run.runId)
      t.ok('the baseline itself still loads, carrying the error', stored instanceof Map && /baseline-modes\.json/.test(stored.modesError ?? ''))
      let threw = null
      try { await fingerprint(run.run.workspace.path, { baseline: stored }) } catch (error) { threw = error }
      t.ok('a fingerprint against it is refused, not silently mode-blind', /unreadable/.test(threw?.message ?? ''))
      await fs.rm(path.join(dir, 'baseline-modes.json'))
      run.baseline = null
      const legacy = await workspaceUnchanged(run)
      t.eq('an absent sidecar is legacy: the mode change is invisible, and it says so honestly', `${legacy.unchanged}/${legacy.proven}`, 'true/true')
      t.eq('and loads without an error', (await readBaseline(g.issuePath, run.runId)).modesError, undefined)
      await releaseWorkspace(run)
    }
  } finally {
    await cleanupFixtures()
  }
}
