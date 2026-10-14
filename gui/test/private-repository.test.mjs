import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { gitWorktreeProvider, worktreeDiffDelivery, startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { baselineOf, fingerprint } from '../server/runtime/fingerprint.mjs'
import { publishCandidate, translate } from '../server/runtime/publication.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { engineFixture } from './fakes/fixture.mjs'
import { applyFence, PANEL_ROOT } from '../../harness/fence.mjs'
import { runProcess } from '../server/runtime/process.mjs'

export const name = '0d — private run repositories: engine and worker Git directories, atomic publication, translation onto the source base'

const exec = promisify(execFile)
const git = async (dir, ...args) => (await exec('git', ['-C', dir, ...args])).stdout.trim()
const gd = async (gitDir, ...args) => (await exec('git', ['--git-dir', gitDir, ...args])).stdout.trim()
const NL = String.fromCharCode(10)

export default async function (t) {
  const temps = []
  const temp = async (p) => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p))); temps.push(d); return d }

  async function project ({ secret = false } = {}) {
    const dir = await temp('pr-proj-')
    await git(dir, 'init', '-q', '-b', 'main'); await git(dir, 'config', 'user.email', 't@t'); await git(dir, 'config', 'user.name', 'T')
    await fs.writeFile(path.join(dir, 'app.txt'), 'v1' + NL)
    await fs.writeFile(path.join(dir, 'other.txt'), 'o1' + NL)
    if (secret) await fs.writeFile(path.join(dir, 'secret.env'), 'TOKEN=committed' + NL)
    await git(dir, 'add', '-A'); await git(dir, 'commit', '-qm', 'first')
    await fs.writeFile(path.join(dir, 'history-only.txt'), 'old' + NL)
    await git(dir, 'add', '-A'); await git(dir, 'commit', '-qm', 'second')
    await git(dir, 'rm', '-q', 'history-only.txt'); await git(dir, 'commit', '-qm', 'third')
    return dir
  }
  async function provision (projectPath, policy) {
    const runs = await temp('pr-runs-')
    const runId = 'run-' + Math.random().toString(16).slice(2, 10)
    await fs.mkdir(path.join(runs, runId), { recursive: true })
    const ws = await gitWorktreeProvider.create({ projectPath, runId, root: runs, policy: { repository: 1, ...policy } })
    return { ws, runId, runDir: path.join(runs, runId) }
  }

  t.section('1. the work tree gets its own repositories, and the source keeps no registration')
  const src = await project()
  const { ws, runId, runDir } = await provision(src, { base: 'head' })
  // As the engine does: the baseline is taken at provisioning, before any seat.
  const wsBaseline = await baselineOf(ws.path)
  {
    const repo = ws.repository
    t.eq('recorded as private', repo?.kind, 'private')
    t.eq('the engine directory is the recorded git directory', ws.gitDir, repo.engine)
    t.eq('the work tree names the worker directory', (await fs.readFile(path.join(ws.path, '.git'), 'utf8')).trim(), `gitdir: ${repo.worker}`)
    t.eq('the recorded entry is that', ws.gitEntry.trim(), `gitdir: ${repo.worker}`)
    t.ok('both live under the run directory', repo.engine.startsWith(runDir + '/') && repo.worker.startsWith(runDir + '/'))
    t.eq('the engine HEAD is the base', await gd(repo.engine, 'rev-parse', 'HEAD'), ws.baseCommit)
    t.eq('the engine holds one commit: no history', (await gd(repo.engine, 'rev-list', '--all')).split(NL).length, 1)
    t.ok('the source keeps no worktree registration for the run', !(await git(src, 'worktree', 'list', '--porcelain')).includes(ws.path))
    t.eq('the snapshot is pinned in the source', await git(src, 'rev-parse', `refs/devpanel/base/${runId}`), ws.baseCommit)
    t.eq('the source base is the base (head, nothing filtered)', ws.sourceBase, ws.baseCommit)
  }

  t.section('2. worker Git works in the tree and reveals no history')
  {
    t.eq('status is clean', await git(ws.path, 'status', '--porcelain'), '')
    t.eq('log shows the snapshot alone', (await git(ws.path, 'log', '--format=%H')).split(NL), [ws.baseCommit])
    const old = await exec('git', ['-C', ws.path, 'cat-file', '-e', `${ws.baseCommit}~1`]).then(() => true, () => false)
    t.eq('the parent commit is not reachable', old, false)
    await fs.writeFile(path.join(ws.path, 'app.txt'), 'v2' + NL)
    await git(ws.path, '-c', 'user.name=s', '-c', 'user.email=s@s', 'commit', '-qam', 'seat work')
    t.eq('a seat can commit in its own directory', (await git(ws.path, 'log', '--format=%s', '-1')), 'seat work')
    t.eq('the engine HEAD did not move', await gd(ws.repository.engine, 'rev-parse', 'HEAD'), ws.baseCommit)
    t.eq('nor did the source', await git(src, 'rev-parse', 'HEAD'), (await git(src, 'rev-parse', 'main')))
    t.ok('the seat\'s objects stay in the worker directory', !(await exec('git', ['--git-dir', ws.repository.engine, 'cat-file', '-e', await git(ws.path, 'rev-parse', 'HEAD')]).then(() => true, () => false)))
  }

  t.section('3. a commit candidate is published into the source atomically')
  let receipt
  {
    const baseline = wsBaseline
    const fp = await fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline })
    await fs.mkdir(path.join(runDir, 'artifacts'), { recursive: true })
    receipt = await worktreeDiffDelivery.deliver({ action: 'commit', revision: fp.fingerprint, fingerprint: fp, baseCommit: ws.baseCommit, baseline, workspacePath: ws.path, workspace: ws, runDir, label: 'test' })
    t.eq('verified', receipt.reconstruction?.verified, true)
    t.eq('the receipt names the source repository', receipt.repository, ws.repository.source)
    t.eq('identity translation (nothing filtered)', receipt.publication?.translation, 'identity')
    t.eq('the reviewed commit is the one integrated', receipt.reviewed, receipt.commit)
    t.eq('the candidate branch is in the source', await git(src, 'rev-parse', `refs/heads/${receipt.branch}`), receipt.commit)
    t.eq('the reviewed ref too', await git(src, 'rev-parse', `refs/devpanel/reviewed/${runId}`), receipt.commit)
    t.eq('and the candidates ref', await git(src, 'rev-parse', `refs/devpanel/candidates/${runId}`), receipt.commit)
    t.eq('its parent is the pinned base', await git(src, 'rev-parse', `${receipt.commit}^`), ws.baseCommit)
    t.eq('the temporary ref is gone', await exec('git', ['-C', src, 'rev-parse', '-q', '--verify', `refs/devpanel/tmp/${runId}`]).then(() => 'present', () => 'absent'), 'absent')
    const journal = JSON.parse(await fs.readFile(path.join(runDir, 'publication.json'), 'utf8'))
    t.eq('the journal says published', journal.phase, 'published')
    const again = await publishCandidate({ repository: ws.repository, runId, runDir, reviewed: receipt.reviewed, filteredBase: ws.baseCommit, sourceBase: ws.sourceBase, branch: receipt.branch })
    t.eq('a replay reconciles instead of repeating', again.published, true, again.reason)
  }

  t.section('3b. a replayed delivery rebuilds the same commit and never takes a branch a person moved (audit I2)')
  {
    const baseline = wsBaseline
    const fp = await fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline })
    const before = await git(src, 'rev-parse', `refs/heads/${receipt.branch}`)
    const replay = await worktreeDiffDelivery.deliver({ action: 'commit', revision: fp.fingerprint, fingerprint: fp, baseCommit: ws.baseCommit, baseline, workspacePath: ws.path, workspace: ws, runDir, label: 'test' })
    t.eq('the same revision delivers the same commit id', replay.commit, receipt.commit)
    t.eq('and stays published', replay.reconstruction?.verified, true, replay.reconstruction?.detail)
    // A person commits on the candidate branch; the run's next delivery
    // (finalize) must not move it back.
    await exec('git', ['-C', src, 'update-ref', `refs/heads/${receipt.branch}`, (await git(src, 'commit-tree', `${receipt.commit}^{tree}`, '-p', receipt.commit, '-m', 'by hand')), before])
    const moved = await git(src, 'rev-parse', `refs/heads/${receipt.branch}`)
    const later = await worktreeDiffDelivery.deliver({ action: 'commit', revision: fp.fingerprint, fingerprint: fp, baseCommit: ws.baseCommit, baseline, workspacePath: ws.path, workspace: ws, runDir, label: 'test' })
    t.eq('the replay is refused', later.reconstruction?.verified, false)
    t.ok('as delivery-unverifiable, naming the branch', /delivery-unverifiable/.test(later.reconstruction?.detail ?? '') && (later.reconstruction?.detail ?? '').includes(receipt.branch), later.reconstruction?.detail)
    t.eq('the branch keeps the person\'s commit', await git(src, 'rev-parse', `refs/heads/${receipt.branch}`), moved)
    t.eq('the reviewed ref did not move', await git(src, 'rev-parse', `refs/devpanel/reviewed/${runId}`), receipt.reviewed)
    await git(src, 'update-ref', `refs/heads/${receipt.branch}`, before)
  }

  t.section('4. a ref holding a third value refuses publication and nothing moves')
  {
    const other = await git(src, 'rev-parse', 'main')
    await fs.rm(path.join(runDir, 'publication.json'))
    await git(src, 'update-ref', `refs/devpanel/candidates/${runId}`, other)
    await git(src, 'update-ref', '-d', `refs/devpanel/reviewed/${runId}`)
    // A new journal reads the current values as expected-old: publication
    // proceeds over them. A journal from before the interference does not.
    const journalled = await publishCandidate({ repository: ws.repository, runId, runDir, reviewed: receipt.reviewed, filteredBase: ws.baseCommit, sourceBase: ws.sourceBase, branch: receipt.branch })
    t.eq('with a fresh journal the refs are taken over their read values', journalled.published, true, journalled.reason)
    const third = await git(src, 'rev-parse', 'main~1')
    await git(src, 'update-ref', `refs/devpanel/candidates/${runId}`, third)
    const refused = await publishCandidate({ repository: ws.repository, runId, runDir, reviewed: receipt.reviewed, filteredBase: ws.baseCommit, sourceBase: ws.sourceBase, branch: receipt.branch })
    t.eq('a third value refuses', refused.published, false)
    t.ok('as delivery-unverifiable, naming the ref', /delivery-unverifiable/.test(refused.reason) && refused.reason.includes(`refs/devpanel/candidates/${runId}`), refused.reason)
    t.eq('nothing was overwritten', await git(src, 'rev-parse', `refs/devpanel/candidates/${runId}`), third)
    t.eq('the other refs did not move either', await git(src, 'rev-parse', `refs/devpanel/reviewed/${runId}`), receipt.reviewed)
  }

  t.section('5. mixed state: one ref already published, the other finished in one transaction')
  {
    const src2 = await project()
    const p = await provision(src2, { base: 'head' })
    const baseline = await baselineOf(p.ws.path)
    await fs.writeFile(path.join(p.ws.path, 'app.txt'), 'mixed' + NL)
    const fp = await fingerprint(p.ws.path, { baseCommit: p.ws.baseCommit, baseline })
    await fs.mkdir(path.join(p.runDir, 'artifacts'), { recursive: true })
    const r = await worktreeDiffDelivery.deliver({ action: 'commit', revision: fp.fingerprint, fingerprint: fp, baseCommit: p.ws.baseCommit, baseline, workspacePath: p.ws.path, workspace: p.ws, runDir: p.runDir })
    // Roll the branch back to its journaled old value (absent): a person moved it.
    await git(src2, 'update-ref', '-d', `refs/heads/${r.branch}`)
    const again = await publishCandidate({ repository: p.ws.repository, runId: p.runId, runDir: p.runDir, reviewed: r.reviewed, filteredBase: p.ws.baseCommit, sourceBase: p.ws.sourceBase, branch: r.branch })
    t.eq('the remaining ref is published', again.published, true, again.reason)
    t.eq('the branch is back at the candidate', await git(src2, 'rev-parse', `refs/heads/${r.branch}`), r.commit)
    await gitWorktreeProvider.release({ projectPath: src2, path: p.ws.path, repository: p.ws.repository })
  }

  t.section('6. translation: the reviewed change onto the source base, never the excluded content')
  {
    const src3 = await project({ secret: true })
    await fs.writeFile(path.join(src3, 'secret.env'), 'TOKEN=local-modified' + NL)   // an uncommitted, excluded change
    await fs.writeFile(path.join(src3, 'other.txt'), 'o2-uncommitted' + NL)          // an uncommitted, selected change
    const p = await provision(src3, { base: 'working-tree', excludes: ['secret.env'] })
    t.ok('A and S differ', p.ws.sourceBase && p.ws.sourceBase !== p.ws.baseCommit)
    t.eq('S is a child of A', await git(src3, 'rev-parse', `${p.ws.baseCommit}^`), p.ws.sourceBase)
    t.eq('A keeps HEAD\'s content for the excluded tracked path', await git(src3, 'show', `${p.ws.sourceBase}:secret.env`), 'TOKEN=committed')
    t.eq('A carries the selected uncommitted change', await git(src3, 'show', `${p.ws.sourceBase}:other.txt`), 'o2-uncommitted')
    t.ok('S has no excluded path', !(await git(src3, 'ls-tree', '--name-only', p.ws.baseCommit)).split(NL).includes('secret.env'))
    const baseline = await baselineOf(p.ws.path)
    await fs.writeFile(path.join(p.ws.path, 'app.txt'), 'reviewed' + NL)
    const fp = await fingerprint(p.ws.path, { baseCommit: p.ws.baseCommit, baseline })
    await fs.mkdir(path.join(p.runDir, 'artifacts'), { recursive: true })
    const r = await worktreeDiffDelivery.deliver({ action: 'commit', revision: fp.fingerprint, fingerprint: fp, baseCommit: p.ws.baseCommit, baseline, workspacePath: p.ws.path, workspace: p.ws, runDir: p.runDir })
    t.eq('verified and translated', [r.reconstruction?.verified, r.publication?.translation], [true, 'applied'], r.reconstruction?.detail)
    t.eq('the integration commit sits on A', await git(src3, 'rev-parse', `${r.commit}^`), p.ws.sourceBase)
    t.eq('it changes exactly the reviewed path', await git(src3, 'diff', '--name-only', p.ws.sourceBase, r.commit), 'app.txt')
    t.eq('and keeps the excluded path as A has it', await git(src3, 'show', `${r.commit}:secret.env`), 'TOKEN=committed')
    t.eq('the reviewed commit is kept beside it', await git(src3, 'rev-parse', `refs/devpanel/reviewed/${p.runId}`), r.reviewed)
    t.eq('the branch holds the integration commit', await git(src3, 'rev-parse', `refs/heads/${r.branch}`), r.commit)
    t.ok('the local, uncommitted secret reached no commit', !(await git(src3, 'log', '--all', '-p')).includes('local-modified'))

    t.section('7. an untranslatable change is refused for commit delivery, with the reviewed commit kept')
    const refused = await translate({ source: p.ws.repository.source, reviewed: r.reviewed, filteredBase: p.ws.baseCommit, sourceBase: p.ws.sourceBase, materialized: ['app.txt'] })
    t.eq('a delta through a materialized path is refused', refused.translation, 'refused')
    t.ok('naming the path', refused.paths?.some((x) => x.path === 'app.txt'), JSON.stringify(refused))
    const q = await provision(src3, { base: 'working-tree', excludes: ['secret.env'] })
    const qb = await baselineOf(q.ws.path)
    await fs.writeFile(path.join(q.ws.path, 'secret.env'), 'TOKEN=written-by-seat' + NL)
    const qfp = await fingerprint(q.ws.path, { baseCommit: q.ws.baseCommit, baseline: qb })
    await fs.mkdir(path.join(q.runDir, 'artifacts'), { recursive: true })
    const qr = await worktreeDiffDelivery.deliver({ action: 'commit', revision: qfp.fingerprint, fingerprint: qfp, baseCommit: q.ws.baseCommit, baseline: qb, workspacePath: q.ws.path, workspace: q.ws, runDir: q.runDir })
    t.eq('a candidate writing an excluded path is not integrable', qr.reconstruction?.verified, false)
    t.ok('integration-translation-failed, naming it', /integration-translation-failed/.test(qr.reconstruction?.detail ?? '') && /secret\.env/.test(qr.reconstruction.detail), qr.reconstruction?.detail)
    t.ok('the reviewed commit is still published for inspection', Boolean(await git(src3, 'rev-parse', `refs/devpanel/reviewed/${q.runId}`)))
    // Audit I8: the candidate refs never point at C, whose ancestry deletes the
    // excluded file; nothing but the reviewed ref is published.
    const absent = async (ref) => exec('git', ['-C', src3, 'rev-parse', '-q', '--verify', ref]).then(() => false, () => true)
    t.ok('the candidates ref is not set', await absent(`refs/devpanel/candidates/${q.runId}`))
    t.ok('and no candidate branch is created', (await exec('git', ['-C', src3, 'for-each-ref', 'refs/heads/devpanel/'])).stdout.trim() === '' || qr.branch === null, JSON.stringify({ branch: qr.branch }))
    t.eq('the receipt names no integrable commit', qr.commit ?? null, null)
    for (const x of [p, q]) await gitWorktreeProvider.release({ projectPath: src3, path: x.ws.path, repository: x.ws.repository })
  }

  t.section('8. release takes the tree and both directories; the refs stay')
  {
    await gitWorktreeProvider.release({ projectPath: src, path: ws.path, repository: ws.repository })
    t.eq('the tree is gone', await fs.lstat(ws.path).then(() => true, () => false), false)
    t.eq('the repositories are gone', await fs.lstat(ws.repository.root).then(() => true, () => false), false)
    t.eq('the base ref stays for the published candidate', await git(src, 'rev-parse', `refs/devpanel/base/${runId}`), ws.baseCommit)
  }

  t.section('9. the fence: the writer gets its worker directory, everyone the engine objects read-only, nobody the source')
  {
    const f = await engineFixture({ playbook: 'implementation' })
    const runOptions = { participants: { 'auditor-1': { model: 'gpt-6-astra' } } }
    const resolved = await resolvePlaybook('implementation', { root: f.configRoot, runOptions, projectId: 'devpanel-project' })
    t.eq('the policy is frozen on the snapshot', resolved.resolved.fence.repository, 1)
    const engine = await startRun({ expectConfigHash: resolved.resolved.configHash, playbookId: 'implementation', issue: { ...f.issue, project: 'devpanel-project' },
      issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider,
      configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery, runOptions })
    const saved = process.env.DEVPANEL_FENCE
    delete process.env.DEVPANEL_FENCE
    try {
      const repo = engine.run.workspace.repository
      t.eq('a fixture run is provisioned private', repo?.kind, 'private')
      const writer = await engine.fenceSpec({ coordinationOnly: false, tooling: { writesCode: true, allowedRoots: [] }, scratchDir: engine.run.workspace.scratchPath })
      const reader = await engine.fenceSpec({ coordinationOnly: false, tooling: { writesCode: false, allowedRoots: [] }, scratchDir: engine.run.workspace.scratchPath })
      t.ok('the writer may write its worker directory', writer.writable.includes(repo.worker))
      t.ok('a reviewer reads it only', reader.readOnly.includes(repo.worker) && !reader.writable.includes(repo.worker))
      t.ok('both read the engine objects', [writer, reader].every((s) => s.readOnly.includes(path.join(repo.engine, 'objects'))))
      t.ok('no one gets the engine directory itself or the source repository', [writer, reader].every((s) => ![...s.readOnly, ...s.writable].some((p) => p === repo.engine || p === repo.source || p.startsWith(repo.source))))
      const tooling = engine.toolingPolicy('implementer')
      t.eq('the tooling policy names the worker directory', tooling.gitWorker, repo.worker)
    } finally {
      if (saved === undefined) delete process.env.DEVPANEL_FENCE; else process.env.DEVPANEL_FENCE = saved
      await releaseWorkspace(engine)
    }
  }

  t.section('10. a dangling escaping link stays a link and does not stop provisioning')
  {
    const src4 = await project()
    const outside = await temp('pr-outside-')
    await fs.writeFile(path.join(outside, 'lib.mjs'), 'export default 1' + NL)
    await fs.mkdir(path.join(src4, 'docs'))
    await fs.symlink(path.join(outside, 'lib.mjs'), path.join(src4, 'docs', 'live-link.mjs'))
    await fs.symlink(path.join(outside, 'gone', 'missing.mjs'), path.join(src4, 'docs', 'dangling.mjs'))
    const p = await provision(src4, { base: 'working-tree', symlinks: 'materialize', selection: 1, materializeGrants: [{ path: outside, reason: 'test' }] })
    t.ok('the live link was materialized', p.ws.symlinks.materialized.includes('docs/live-link.mjs'))
    t.eq('the dangling one is recorded', p.ws.symlinks.dangling?.map((l) => l.path), ['docs/dangling.mjs'])
    t.eq('and kept as the same link', await fs.readlink(path.join(p.ws.path, 'docs', 'dangling.mjs')), path.join(outside, 'gone', 'missing.mjs'))
    await gitWorktreeProvider.release({ projectPath: src4, path: p.ws.path, repository: p.ws.repository })
  }

  t.section('11. inside a real fence: the writer commits in its worker directory; a reviewer reads and cannot write')
  {
    const src5 = await project()
    const p = await provision(src5, { base: 'head' })
    const scratch = await temp('pr-scratch-')
    const repo = p.ws.repository
    const inFence = async (spec, script) => {
      const fence = await applyFence({ spec: { cwd: p.ws.path, entries: [path.join(p.ws.path, '.git')], panelRoot: PANEL_ROOT, ...spec }, manifest: { homeBinds: [{ path: path.join(os.homedir(), '.gitconfig'), writable: false }] } })
      if (!fence.applied) return { skipped: fence.reason }
      const cmd = fence.wrap('/bin/sh', ['-c', script])
      const out = await runProcess({ ...cmd, env: { PATH: '/usr/bin:/bin', HOME: os.homedir(), GIT_AUTHOR_NAME: 's', GIT_AUTHOR_EMAIL: 's@s', GIT_COMMITTER_NAME: 's', GIT_COMMITTER_EMAIL: 's@s' }, stdin: '' })
      return out
    }
    const writer = await inFence({ writable: [p.ws.path, repo.worker, scratch], readOnly: [path.join(repo.engine, 'objects')] },
      'set -e; echo seat > app.txt; git status --porcelain; git add -A; git commit -qm "seat commit"; git log --oneline | wc -l; git rev-parse HEAD')
    if (writer.skipped) t.skip('11. worker Git in a real fence', writer.skipped)
    else {
      t.eq('the writer\'s git status, add and commit work inside the fence', writer.code, 0, writer.stderr)
      const lines = writer.stdout.trim().split(NL)
      t.eq('its history is the snapshot plus its own commit', lines.at(-2), '2')
      t.eq('the commit landed in the worker directory', await gd(repo.worker, 'rev-parse', 'HEAD'), lines.at(-1))
      t.eq('the engine directory did not move', await gd(repo.engine, 'rev-parse', 'HEAD'), p.ws.baseCommit)
      const reviewer = await inFence({ writable: [scratch], readOnly: [p.ws.path, repo.worker, path.join(repo.engine, 'objects')] },
        'git log --oneline | wc -l; git diff --stat HEAD~1 | tail -1; if git commit -qm x --allow-empty 2>/dev/null; then echo COMMITTED; fi; if [ -e ' + repo.engine + '/config ]; then echo ENGINE-VISIBLE; fi; if [ -e ' + src5 + ' ]; then echo SOURCE-VISIBLE; fi')
      t.eq('a reviewer reads the history and the diff', reviewer.stdout.split(NL)[0], '2', reviewer.stderr)
      t.ok('but cannot commit', !reviewer.stdout.includes('COMMITTED'))
      t.ok('and sees neither the engine directory nor the source repository', !reviewer.stdout.includes('ENGINE-VISIBLE') && !reviewer.stdout.includes('SOURCE-VISIBLE'), reviewer.stdout)
    }
    await gitWorktreeProvider.release({ projectPath: src5, path: p.ws.path, repository: repo })
  }
  await Promise.all(temps.map((d) => fs.rm(d, { recursive: true, force: true })))
}
