import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { gitWorktreeProvider, worktreeDiffDelivery, startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { baselineOf, fingerprint } from '../server/runtime/fingerprint.mjs'
import { integrateRun } from '../server/runtime/integrate.mjs'
import { supportedActions } from '../server/supervisor.mjs'
import * as store from '../server/runtime/store.mjs'
import { engineFixture, scriptFor, cleanupFixtures } from './fakes/fixture.mjs'
import { sandbox } from './helpers.mjs'

export const name = 'commit delivery and approved integration — into the right repository, bound to the revision, never half-merged'

const run = promisify(execFile)
const NL = String.fromCharCode(10)
const temps = []
const temp = async (p) => { const d = await fs.mkdtemp(path.join(os.tmpdir(), p)); temps.push(d); return d }

async function project () {
  const dir = await temp('int-proj-')
  await run('git', ['-C', dir, 'init', '-q', '-b', 'main'])
  await run('git', ['-C', dir, 'config', 'user.email', 't@example.invalid'])
  await run('git', ['-C', dir, 'config', 'user.name', 'T'])
  await fs.writeFile(path.join(dir, 'a.txt'), 'one' + NL)
  await run('git', ['-C', dir, 'add', '-A'])
  await run('git', ['-C', dir, 'commit', '-qm', 'base'])
  return dir
}

/** A committed candidate on a devpanel/ branch, with its run record on disk. */
async function committedCandidate ({ projectPath, issueId = '2026-09-12-int-issue', edit = 'two' } = {}) {
  projectPath ??= await project()
  const issuePath = path.join(await temp('int-issue-'), issueId)
  const runId = '2026-09-12T00-00-00-000Z-abcdef12'
  const runDir = path.join(issuePath, 'runs', runId)
  await fs.mkdir(path.join(runDir, 'artifacts'), { recursive: true })
  const ws = await gitWorktreeProvider.create({ projectPath, runId, root: path.join(issuePath, 'runs'), policy: { base: 'head' } })
  const baseline = await baselineOf(ws.path)
  await fs.writeFile(path.join(ws.path, 'a.txt'), edit + NL)
  const fp = await fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline })
  const receipt = await worktreeDiffDelivery.deliver({ action: 'commit', revision: fp.fingerprint, fingerprint: fp, baseCommit: ws.baseCommit, baseline, workspacePath: ws.path, runDir, label: 'test candidate' })
  const record = {
    runId, issue: { project: 'p', id: issueId }, playbook: { id: 'x', version: 1 }, status: 'completed', outcome: 'resolved', participants: {}, steps: [],
    revisions: [{ fingerprint: fp.fingerprint }], approvals: [], checkResults: [], outstandingFindings: [],
    workspace: { ...ws, state: 'active' },
    delivery: { action: 'commit', revision: fp.fingerprint, completedAt: 't', artifactRef: receipt.artifactRef, reconstruction: receipt.reconstruction, repository: receipt.repository, branch: receipt.branch, commit: receipt.commit },
    closure: { revision: fp.fingerprint }
  }
  await store.writeRun(issuePath, runId, record)
  await fs.writeFile(path.join(runDir, 'events.jsonl'), JSON.stringify({ type: 'delivered', at: 't' }) + NL)
  return { projectPath, issuePath, runId, ws, fp, receipt, record }
}

export default async function (t) {
  t.section('1. commit delivery: a verified commit on a devpanel/ branch, parented on the base')
  {
    const c = await committedCandidate()
    t.ok('a commit exists', /^[0-9a-f]{40}$/.test(c.receipt.commit ?? ''))
    t.ok('on a devpanel branch named for the issue and run', c.receipt.branch.startsWith('devpanel/2026-09-12-int-issue/'), c.receipt.branch)
    t.eq('parented on the base', (await run('git', ['-C', c.projectPath, 'rev-parse', `${c.receipt.commit}^`])).stdout.trim(), c.ws.baseCommit)
    t.eq('the branch points at it', (await run('git', ['-C', c.projectPath, 'rev-parse', c.receipt.branch])).stdout.trim(), c.receipt.commit)
    t.eq('the patch was still written', typeof c.receipt.artifactRef, 'string')
    t.eq('and the commit itself was verified against the revision', c.receipt.reconstruction.commit.verified, true)
    t.eq('the repository is recorded', c.receipt.repository, await fs.realpath(path.join(c.projectPath, '.git')))
    t.eq('main is untouched', (await run('git', ['-C', c.projectPath, 'rev-parse', 'main'])).stdout.trim(), c.ws.baseCommit)
    t.ok('the run offers integrate', supportedActions(c.record).includes('integrate'))
  }

  t.section('2. integrate into a branch that is not checked out merges in a temporary worktree')
  {
    const c = await committedCandidate()
    await run('git', ['-C', c.projectPath, 'branch', 'integration', 'main'])
    const cfgRoot = await sandbox(async (dir) => {
      await fs.mkdir(path.join(dir, 'projects'), { recursive: true })
      await fs.writeFile(path.join(dir, 'projects', 'p.yaml'), `id: p${NL}sourceRepository: ${c.projectPath}${NL}integrationBranch: integration${NL}`)
    })
    const { integrationTarget } = await import('../server/runtime/integrate.mjs')
    const target = await integrationTarget({ project: 'p', projectPath: c.projectPath, configRoot: cfgRoot, runId: c.runId, issuePath: c.issuePath })
    t.eq('the target names the declared branch and its head', `${target.branch}:${target.head}`, `integration:${c.ws.baseCommit}`)
    t.eq('and confirms the repositories match', target.sameRepository, true)
    const result = await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: cfgRoot, expectedRevision: c.fp.fingerprint, targetBranch: target.branch, expectedTargetHead: target.head })
    t.eq('no error', result.error, null, result.error)
    t.eq('method', result.integration.method, 'built-on-approved-head, published-by-compare-and-swap')
    t.eq('target head before recorded', result.integration.targetHeadBefore, c.ws.baseCommit)
    const head = (await run('git', ['-C', c.projectPath, 'rev-parse', 'integration'])).stdout.trim()
    t.eq('integration moved to the merge commit', head, result.integration.mergeCommit)
    const parents = (await run('git', ['-C', c.projectPath, 'rev-list', '--parents', '-n', '1', head])).stdout.trim().split(' ')
    t.ok('a real merge with the candidate as second parent', parents.length === 3 && parents[2] === c.receipt.commit)
    t.eq('the checkout was not touched', (await run('git', ['-C', c.projectPath, 'branch', '--show-current'])).stdout.trim(), 'main')
    t.eq('no worktree left behind', (await run('git', ['-C', c.projectPath, 'worktree', 'list'])).stdout.trim().split(NL).length, 2)
    t.ok('the run no longer offers integrate', !supportedActions(await store.readRun(c.issuePath, c.runId)).includes('integrate'))
    const again = await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: cfgRoot, expectedRevision: c.fp.fingerprint, targetBranch: 'integration', expectedTargetHead: head }).catch((e) => ({ error: e.message }))
    t.ok('a second approval is refused', /already integrated/.test(again.error ?? ''), again.error)
  }

  t.section('3. a clean checkout of the target merges in place; a dirty one is refused')
  {
    const c = await committedCandidate()
    const declare = (projectPath) => sandbox(async (dir) => {
      await fs.mkdir(path.join(dir, 'projects'), { recursive: true })
      await fs.writeFile(path.join(dir, 'projects', 'p.yaml'), `id: p${NL}sourceRepository: ${projectPath}${NL}integrationBranch: main${NL}`)
    })
    const undeclared = await sandbox(async () => {})
    const guess = await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: undeclared, expectedRevision: c.fp.fingerprint, targetBranch: 'main', expectedTargetHead: c.ws.baseCommit }).catch((e) => ({ error: e.message }))
    t.ok('an undeclared project is refused, never guessed', /no complete declaration of its source repository/.test(guess.error ?? ''), guess.error)

    const cfgRoot = await declare(c.projectPath)
    const missingHead = await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: cfgRoot, expectedRevision: c.fp.fingerprint, targetBranch: 'main' }).catch((e) => ({ error: e.message }))
    t.ok('an approval without the target head is refused', /expectedTargetHead/.test(missingHead.error ?? ''), missingHead.error)
    const result = await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: cfgRoot, expectedRevision: c.fp.fingerprint, targetBranch: 'main', expectedTargetHead: c.ws.baseCommit })
    t.eq('published by compare-and-swap with the checkout brought along', `${result.integration.method}:${result.integration.worktrees.updated.length}`, 'built-on-approved-head, published-by-compare-and-swap:1', result.error)
    t.eq('and the working tree followed', await fs.readFile(path.join(c.projectPath, 'a.txt'), 'utf8'), 'two' + NL)

    const d = await committedCandidate({ edit: 'three' })
    const cfgD = await declare(d.projectPath)
    await fs.writeFile(path.join(d.projectPath, 'a.txt'), 'local edit' + NL)
    const refused = await integrateRun({ issuePath: d.issuePath, runId: d.runId, project: 'p', projectPath: d.projectPath, configRoot: cfgD, expectedRevision: d.fp.fingerprint, targetBranch: 'main', expectedTargetHead: d.ws.baseCommit })
    t.ok('refused', /modified tracked path/.test(refused.error ?? ''), refused.error)
    t.eq('recorded on the run', (await store.readRun(d.issuePath, d.runId)).integration.error, refused.error)
    t.eq('the checkout is untouched', await fs.readFile(path.join(d.projectPath, 'a.txt'), 'utf8'), 'local edit' + NL)
  }

  t.section('4. the wrong revision, a moved target, the wrong repository, and a conflict are all refused cleanly')
  {
    const c = await committedCandidate()
    const cfgRoot = await sandbox(async (dir) => {
      await fs.mkdir(path.join(dir, 'projects'), { recursive: true })
      await fs.writeFile(path.join(dir, 'projects', 'p.yaml'), `id: p${NL}sourceRepository: ${c.projectPath}${NL}integrationBranch: main${NL}`)
    })
    const wrong = await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: cfgRoot, expectedRevision: 'sha256:' + '0'.repeat(64), targetBranch: 'main', expectedTargetHead: c.ws.baseCommit }).catch((e) => ({ error: e.message }))
    t.ok('an approval for another revision is refused', /approval names revision/.test(wrong.error ?? ''), wrong.error)

    // The target moves after the operator looked.
    await fs.writeFile(path.join(c.projectPath, 'b.txt'), 'unrelated' + NL)
    await run('git', ['-C', c.projectPath, 'add', 'b.txt'])
    await run('git', ['-C', c.projectPath, 'commit', '-qm', 'someone else'])
    const moved = await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: cfgRoot, expectedRevision: c.fp.fingerprint, targetBranch: 'main', expectedTargetHead: c.ws.baseCommit }).catch((e) => ({ error: e.message }))
    t.ok('a target that moved since approval is refused', /moved since the approval/.test(moved.error ?? ''), moved.error)
    const wrongBranch = await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: cfgRoot, expectedRevision: c.fp.fingerprint, targetBranch: 'other', expectedTargetHead: c.ws.baseCommit }).catch((e) => ({ error: e.message }))
    t.ok('a branch other than the declared one is refused', /integration branch is main/.test(wrongBranch.error ?? ''), wrongBranch.error)

    const other = await project()
    const elsewhere = await sandbox(async (dir) => {
      await fs.mkdir(path.join(dir, 'projects'), { recursive: true })
      await fs.writeFile(path.join(dir, 'projects', 'p.yaml'), `id: p${NL}sourceRepository: ${other}${NL}integrationBranch: main${NL}`)
    })
    const misplaced = await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: elsewhere, expectedRevision: c.fp.fingerprint, targetBranch: 'main', expectedTargetHead: (await run('git', ['-C', other, 'rev-parse', 'main'])).stdout.trim() }).catch((e) => ({ error: e.message }))
    t.ok('a different source repository is refused with the reason', /declared source repository/.test(misplaced.error ?? ''), misplaced.error)

    // A conflicting change lands on main; the operator reads the new head and approves onto it.
    await fs.writeFile(path.join(c.projectPath, 'a.txt'), 'conflicting' + NL)
    await run('git', ['-C', c.projectPath, 'commit', '-qam', 'conflict'])
    const nowHead = (await run('git', ['-C', c.projectPath, 'rev-parse', 'main'])).stdout.trim()
    const conflict = await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: cfgRoot, expectedRevision: c.fp.fingerprint, targetBranch: 'main', expectedTargetHead: nowHead })
    t.ok('the merge is aborted and reported', /failed and was aborted/.test(conflict.error ?? ''), conflict.error)
    t.eq('nothing half-merged', (await run('git', ['-C', c.projectPath, 'status', '--porcelain'])).stdout.trim(), '')
  }

  t.section('4b. a branch that moves between building and publishing is never published onto')
  {
    const { integrateRun: integrate } = await import('../server/runtime/integrate.mjs')
    for (const checkedOut of [false, true]) {
      const c = await committedCandidate()
      const branch = checkedOut ? 'main' : 'integration'
      if (!checkedOut) await run('git', ['-C', c.projectPath, 'branch', 'integration', 'main'])
      const cfgRoot = await sandbox(async (dir) => {
        await fs.mkdir(path.join(dir, 'projects'), { recursive: true })
        await fs.writeFile(path.join(dir, 'projects', 'p.yaml'), `id: p${NL}sourceRepository: ${c.projectPath}${NL}integrationBranch: ${branch}${NL}`)
      })
      const advance = async () => {
        // Someone lands a commit on the target after validation, before publication.
        const tmp = path.join(await temp('race-'), 'wt')
        await run('git', ['-C', c.projectPath, 'worktree', 'add', '--quiet', tmp, branch]).catch(async () => {
          // the branch is checked out: commit in the checkout itself
          await fs.writeFile(path.join(c.projectPath, 'race.txt'), 'raced' + NL)
          await run('git', ['-C', c.projectPath, 'add', 'race.txt'])
          await run('git', ['-C', c.projectPath, 'commit', '-qm', 'raced'])
        })
        if (await fs.stat(tmp).then(() => true, () => false)) {
          await fs.writeFile(path.join(tmp, 'race.txt'), 'raced' + NL)
          await run('git', ['-C', tmp, 'add', 'race.txt'])
          await run('git', ['-C', tmp, 'commit', '-qm', 'raced'])
          await run('git', ['-C', c.projectPath, 'worktree', 'remove', '--force', tmp])
        }
      }
      const result = await integrate({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: cfgRoot, expectedRevision: c.fp.fingerprint, targetBranch: branch, expectedTargetHead: c.ws.baseCommit, hooks: { beforePublish: advance } })
      t.ok(`${checkedOut ? 'checked-out' : 'not checked out'}: refused`, /moved|fast-forwarded/.test(result.error ?? ''), result.error)
      const head = (await run('git', ['-C', c.projectPath, 'rev-parse', branch])).stdout.trim()
      const parents = (await run('git', ['-C', c.projectPath, 'rev-list', '--parents', '-n', '1', head])).stdout.trim().split(' ')
      t.eq(`${checkedOut ? 'checked-out' : 'not checked out'}: the branch holds the racing commit, not a merge`, parents.length, 2)
      t.eq(`${checkedOut ? 'checked-out' : 'not checked out'}: no integration recorded as done`, (await store.readRun(c.issuePath, c.runId)).integration.mergeCommit, null)
    }
  }

  t.section('4b2. publication is bound to the named branch, not to whatever HEAD names')
  {
    const c = await committedCandidate()
    const cfgRoot = await sandbox(async (dir) => {
      await fs.mkdir(path.join(dir, 'projects'), { recursive: true })
      await fs.writeFile(path.join(dir, 'projects', 'p.yaml'), `id: p${NL}sourceRepository: ${c.projectPath}${NL}integrationBranch: main${NL}`)
    })
    // Between build and publish the checkout switches to another branch at the same commit.
    const swap = async () => { await run('git', ['-C', c.projectPath, 'checkout', '-q', '-b', 'other']) }
    const result = await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: cfgRoot, expectedRevision: c.fp.fingerprint, targetBranch: 'main', expectedTargetHead: c.ws.baseCommit, hooks: { beforePublish: swap } })
    t.eq('published', result.error, null, result.error)
    t.eq('main received the merge', (await run('git', ['-C', c.projectPath, 'rev-parse', 'main'])).stdout.trim(), result.integration.mergeCommit)
    t.eq('other is untouched', (await run('git', ['-C', c.projectPath, 'rev-parse', 'other'])).stdout.trim(), c.ws.baseCommit)
    t.eq('the receipt names main', result.integration.targetBranch, 'main')
    t.eq('and no worktree needed updating', result.integration.worktrees.updated.length, 0)
  }

  t.section('4b3. a target checked out in another worktree is inspected and brought along')
  {
    const c = await committedCandidate()
    await run('git', ['-C', c.projectPath, 'branch', 'integration', 'main'])
    const elsewhere = path.join(await temp('other-wt-'), 'wt')
    await run('git', ['-C', c.projectPath, 'worktree', 'add', '--quiet', elsewhere, 'integration'])
    const cfgRoot = await sandbox(async (dir) => {
      await fs.mkdir(path.join(dir, 'projects'), { recursive: true })
      await fs.writeFile(path.join(dir, 'projects', 'p.yaml'), `id: p${NL}sourceRepository: ${c.projectPath}${NL}integrationBranch: integration${NL}`)
    })
    // Dirty over there: refused before anything is published.
    await fs.writeFile(path.join(elsewhere, 'a.txt'), 'local edit elsewhere' + NL)
    const refused = await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: cfgRoot, expectedRevision: c.fp.fingerprint, targetBranch: 'integration', expectedTargetHead: c.ws.baseCommit })
    t.ok('refused because of the other worktree', new RegExp(`checked out in ${elsewhere}`).test(refused.error ?? ''), refused.error)
    t.eq('nothing published', (await run('git', ['-C', c.projectPath, 'rev-parse', 'integration'])).stdout.trim(), c.ws.baseCommit)
    // Clean over there: published, and that worktree's files follow.
    await run('git', ['-C', elsewhere, 'checkout', '--', 'a.txt'])
    const ok = await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: cfgRoot, expectedRevision: c.fp.fingerprint, targetBranch: 'integration', expectedTargetHead: c.ws.baseCommit })
    t.eq('published', ok.error, null, ok.error)
    t.eq('the other worktree HEAD is the merge', (await run('git', ['-C', elsewhere, 'rev-parse', 'HEAD'])).stdout.trim(), ok.integration.mergeCommit)
    t.eq('and its files match', await fs.readFile(path.join(elsewhere, 'a.txt'), 'utf8'), 'two' + NL)
    t.eq('recorded as updated', ok.integration.worktrees.updated.length, 1)
    t.eq('the source checkout stayed on main', (await run('git', ['-C', c.projectPath, 'branch', '--show-current'])).stdout.trim(), 'main')
    await run('git', ['-C', c.projectPath, 'worktree', 'remove', '--force', elsewhere])
  }

  t.section('4b4. a crash after the swap is reconciled from the record; a crash before it aborts cleanly')
  {
    const { reconcileIntegration } = await import('../server/runtime/integrate.mjs')
    const crash = () => { throw Object.assign(new Error('simulated process death'), { simulatedCrash: true }) }
    for (const when of ['afterPublish', 'beforePublish']) {
      const c = await committedCandidate()
      await run('git', ['-C', c.projectPath, 'branch', 'integration', 'main'])
      const elsewhere = path.join(await temp('crash-wt-'), 'wt')
      await run('git', ['-C', c.projectPath, 'worktree', 'add', '--quiet', elsewhere, 'integration'])
      const cfgRoot = await sandbox(async (dir) => {
        await fs.mkdir(path.join(dir, 'projects'), { recursive: true })
        await fs.writeFile(path.join(dir, 'projects', 'p.yaml'), `id: p${NL}sourceRepository: ${c.projectPath}${NL}integrationBranch: integration${NL}`)
      })
      let died = null
      try { await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: cfgRoot, expectedRevision: c.fp.fingerprint, targetBranch: 'integration', expectedTargetHead: c.ws.baseCommit, hooks: { [when]: crash } }) } catch (e) { died = e }
      t.ok(`${when}: the process died`, died?.simulatedCrash === true)
      const interrupted = (await store.readRun(c.issuePath, c.runId)).integration
      if (when === 'afterPublish') {
        t.eq('the intent was persisted as published', interrupted.phase, 'published')
        t.eq('the branch holds the merge', (await run('git', ['-C', c.projectPath, 'rev-parse', 'integration'])).stdout.trim(), interrupted.mergeCommit)
        t.eq('but the checkout still shows the old content', await fs.readFile(path.join(elsewhere, 'a.txt'), 'utf8'), 'one' + NL)
        t.ok('a second approval is refused while unfinished', /previous publication is unfinished/.test((await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: cfgRoot, expectedRevision: c.fp.fingerprint, targetBranch: 'integration', expectedTargetHead: c.ws.baseCommit }).catch((e) => ({ error: e.message }))).error ?? ''))
        const settled = await reconcileIntegration({ issuePath: c.issuePath, runId: c.runId })
        t.eq('reconciliation completes it', settled.phase, 'complete')
        t.eq('and the checkout now matches', await fs.readFile(path.join(elsewhere, 'a.txt'), 'utf8'), 'two' + NL)
        t.eq('recorded as updated', settled.integration.worktrees.updated.length, 1)
      } else {
        t.eq('nothing was published', (await run('git', ['-C', c.projectPath, 'rev-parse', 'integration'])).stdout.trim(), c.ws.baseCommit)
        t.eq('no record claims otherwise', interrupted ?? null, null)
      }
      t.eq('reconciling again changes nothing', (await reconcileIntegration({ issuePath: c.issuePath, runId: c.runId })).reconciled, false)
      await run('git', ['-C', c.projectPath, 'worktree', 'remove', '--force', elsewhere])
    }

    // A crash between persisting the intent and the swap: the record says
    // publishing, the branch did not move; reconciliation aborts and re-offers.
    const c = await committedCandidate()
    const runRecord = await store.readRun(c.issuePath, c.runId)
    runRecord.integration = { approvedBy: 'operator', revision: c.fp.fingerprint, repository: c.receipt.repository, targetBranch: 'main', targetHeadBefore: c.ws.baseCommit, mergeCommit: 'deadbeef', method: 'x', at: 't', error: null, phase: 'publishing', worktrees: { pending: [], updated: [], stale: [] } }
    await store.writeRun(c.issuePath, c.runId, runRecord)
    const settled = await reconcileIntegration({ issuePath: c.issuePath, runId: c.runId })
    t.eq('an unswapped publishing record is aborted', settled.phase, 'aborted')
    t.ok('with the reason', /interrupted before the branch moved/.test(settled.integration.error ?? ''), settled.integration.error)
    t.ok('and integrate is offered again', supportedActions(await store.readRun(c.issuePath, c.runId)).includes('integrate'))
  }

  t.section('4c. a declaration that names only an id is not a declaration')
  {
    const c = await committedCandidate()
    const partial = await sandbox(async (dir) => {
      await fs.mkdir(path.join(dir, 'projects'), { recursive: true })
      await fs.writeFile(path.join(dir, 'projects', 'p.yaml'), `id: p${NL}`)
    })
    const result = await integrateRun({ issuePath: c.issuePath, runId: c.runId, project: 'p', projectPath: c.projectPath, configRoot: partial, expectedRevision: c.fp.fingerprint, targetBranch: 'main', expectedTargetHead: c.ws.baseCommit }).catch((e) => ({ error: e.message }))
    t.ok('refused as incomplete', /no complete declaration/.test(result.error ?? ''), result.error)
    t.ok('with the schema\'s words', /invalid.*sourceRepository|integrationBranch/.test(result.error ?? ''), result.error)
    t.eq('main untouched', (await run('git', ['-C', c.projectPath, 'rev-parse', 'main'])).stdout.trim(), c.ws.baseCommit)
  }

  t.section('5. through the engine: an implementation run set to commit delivery commits its candidate')
  {
    const f = await engineFixture({ delivery: 'commit', script: scriptFor() })
    const engine = await startRun({
      playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id },
      issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore,
      workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: worktreeDiffDelivery
    })
    const run_ = await engine.drive()
    t.eq('resolved', run_.outcome, 'resolved', run_.blockedReason)
    t.eq('delivered by commit', run_.delivery.action, 'commit')
    t.ok('with a commit and branch', Boolean(run_.delivery.commit) && run_.delivery.branch.startsWith('devpanel/'))
    t.eq('verified', run_.delivery.reconstruction.verified, true)
    await releaseWorkspace(engine)
  }

  await cleanupFixtures()
  await Promise.all(temps.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})))
}
