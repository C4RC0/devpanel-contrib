import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { gitWorktreeProvider, worktreeDiffDelivery } from '../server/runtime/launch.mjs'
import { applyToSource } from '../server/runtime/source-delivery.mjs'
import { fingerprint, baselineOf } from '../server/runtime/fingerprint.mjs'
import { knownProjectRoots, forbiddenRoots, forbiddenRootsReport, authorizer, PANEL_ROOT } from '../server/runtime/selection.mjs'
import { platformFor } from '../server/runtime/platform.mjs'
import { engineFixture, cleanupFixtures } from './fakes/fixture.mjs'

const exec = promisify(execFile)
const git = async (dir, ...args) => (await exec('git', ['-C', dir, ...args])).stdout
const NL = String.fromCharCode(10)

export const name = 'snapshot selection v1 — a materialized link carries its owner\'s selection'

const temps = []
const temp = async (prefix) => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix))); temps.push(d); return d }
const exists = (p) => fs.lstat(p).then(() => true, () => false)
const write = async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text) }

/**
 * An owner repository shaped like a framework checkout: a collection with tracked source,
 * an untracked source file, and ignored dependency and build output.
 */
async function owner () {
  const dir = await temp('sel-owner-')
  await git(dir, 'init', '-q', '-b', 'main')
  await git(dir, 'config', 'user.email', 't@t'); await git(dir, 'config', 'user.name', 'T')
  await write(path.join(dir, '.gitignore'), `node_modules/${NL}build/${NL}`)
  await write(path.join(dir, 'modules/one/index.mjs'), 'export const one = 1\n')
  await write(path.join(dir, 'modules/one/tool.sh'), '#!/bin/sh\n'); await fs.chmod(path.join(dir, 'modules/one/tool.sh'), 0o755)
  await write(path.join(dir, 'unrelated.txt'), 'not linked')
  await git(dir, 'add', '-A'); await git(dir, 'commit', '-qm', 'base')
  await write(path.join(dir, 'modules/one/draft.mjs'), 'untracked but not ignored\n')
  await write(path.join(dir, 'modules/one/node_modules/dep/index.js'), 'dependency')
  await write(path.join(dir, 'modules/one/build/generated.js'), 'generated')
  return dir
}

/** A projects directory in which `owner` is a known project, as /srv is. */
async function projects (...roots) {
  const dir = await temp('sel-projects-')
  for (const [i, root] of roots.entries()) await fs.symlink(root, path.join(dir, `p${i}-project`))
  return dir
}

async function withProjects (dir, fn) {
  const saved = process.env.DEVPANEL_PROJECTS_DIR
  process.env.DEVPANEL_PROJECTS_DIR = dir
  try { return await fn() } finally { if (saved === undefined) delete process.env.DEVPANEL_PROJECTS_DIR; else process.env.DEVPANEL_PROJECTS_DIR = saved }
}

const create = (f, id, policy) => gitWorktreeProvider.create({ projectPath: f.projectPath, runId: id, root: f.issuePath,
  policy: { base: 'working-tree', symlinks: 'materialize', selection: 1, ...policy } })

export default async function (t) {
  t.section('1. the owner\'s selection is carried, dependency and build output are not')
  {
    const f = await engineFixture()
    const o = await owner()
    await fs.symlink(path.join(o, 'modules'), path.join(f.projectPath, 'shared'))
    const ws = await withProjects(await projects(o, f.projectPath), () => create(f, 'sel-1', {}))
    const has = (rel) => exists(path.join(ws.path, rel))
    t.ok('tracked owner source is copied', await has('shared/one/index.mjs'))
    t.ok('an untracked, not ignored owner file is copied (what the owner would carry)', await has('shared/one/draft.mjs'))
    t.ok('ignored dependencies are not copied', !(await has('shared/one/node_modules')))
    t.ok('ignored build output is not copied', !(await has('shared/one/build')))
    t.eq('the executable bit survives', ((await fs.stat(path.join(ws.path, 'shared/one/tool.sh'))).mode & 0o100) !== 0, true)
    const tree = (await git(ws.path, 'ls-tree', '-r', '--name-only', ws.baseCommit)).split(NL).filter(Boolean)
    t.eq('the base commit tracks exactly the selection plus the application', tree.sort(), ['shared/one/draft.mjs', 'shared/one/index.mjs', 'shared/one/tool.sh', 'source.txt'])
    t.eq('the rule is recorded', ws.symlinks.selection?.rule, 'owner-ls-files/v1')
    t.eq('with the owner and its rule files', ws.symlinks.selection?.owners?.[0]?.owner, o)
    t.ok('rule file hashes recorded', typeof ws.symlinks.selection?.owners?.[0]?.rules?.['.gitignore'] === 'string')
    t.eq('the base records the selection rule', ws.base.selection, 'owner-ls-files/v1')
  }

  t.section('2. without selection v1 nothing changes (runs resolved before the policy step)')
  {
    const f = await engineFixture()
    const o = await owner()
    await fs.symlink(path.join(o, 'modules'), path.join(f.projectPath, 'shared'))
    const ws = await create(f, 'sel-2', { selection: 0 })
    t.ok('the whole target is copied, as before', await exists(path.join(ws.path, 'shared/one/build/generated.js')))
    t.eq('no selection record', ws.symlinks.selection, undefined)
  }

  t.section('3. a target outside the known projects is refused before anything is copied')
  {
    const f = await engineFixture()
    const o = await owner()
    await fs.symlink(path.join(o, 'modules'), path.join(f.projectPath, 'shared'))
    const threw = await withProjects(await projects(f.projectPath), () => create(f, 'sel-3', {})).then(() => null, (e) => e)
    t.eq('refused as unauthorized', threw?.code, 'MATERIALIZE_UNAUTHORIZED')
    t.ok('naming the link', (threw?.message ?? '').includes('shared'), threw?.message)
    t.ok('no worktree is left behind', !(await exists(path.join(f.issuePath, 'worktree-sel-3'))))
    const listed = await git(f.projectPath, 'worktree', 'list', '--porcelain')
    t.ok('and none is registered', !listed.includes('worktree-sel-3'))
  }

  t.section('4. an unowned directory needs an explicit grant')
  {
    const f = await engineFixture()
    const plain = await temp('sel-plain-')
    await write(path.join(plain, 'a.txt'), 'plain'); await write(path.join(plain, 'sub/b.txt'), 'plain b')
    await fs.symlink(plain, path.join(f.projectPath, 'data'))
    const known = await projects(f.projectPath)
    const refused = await withProjects(known, () => create(f, 'sel-4a', {})).then(() => null, (e) => e)
    t.eq('refused without a grant', refused?.code, 'MATERIALIZE_UNAUTHORIZED')
    const ws = await withProjects(known, () => create(f, 'sel-4b', { materializeGrants: [{ path: plain, reason: 'test fixture' }] }))
    t.ok('copied whole with a grant', await exists(path.join(ws.path, 'data/sub/b.txt')))
    t.eq('recorded as unowned', ws.symlinks.selection.owners[0].owner, null)
  }

  t.section('5. exclusions hold for a head base and inside a materialized link')
  {
    const f = await engineFixture()
    await write(path.join(f.projectPath, 'secret.txt'), 'tracked secret')
    await git(f.projectPath, 'add', '-A'); await git(f.projectPath, 'commit', '-qm', 'secret')
    const head = (await git(f.projectPath, 'rev-parse', 'HEAD')).trim()
    const ws = await withProjects(await projects(f.projectPath), () => gitWorktreeProvider.create({ projectPath: f.projectPath, runId: 'sel-5', root: f.issuePath,
      policy: { base: 'head', selection: 1, excludes: ['secret.txt'] } }))
    t.ok('the excluded tracked file is absent from the worktree', !(await exists(path.join(ws.path, 'secret.txt'))))
    t.ok('and from the base tree', !(await git(ws.path, 'ls-tree', '-r', '--name-only', ws.baseCommit)).includes('secret.txt'))
    t.eq('the selected source revision is recorded separately', ws.base.sourceRevision, head)
    t.ok('the filtered base is a child of it', (await git(ws.path, 'rev-parse', `${ws.baseCommit}^`)).trim() === head)

    const f2 = await engineFixture()
    const o = await owner()
    await fs.symlink(path.join(o, 'modules'), path.join(f2.projectPath, 'shared'))
    const ws2 = await withProjects(await projects(o, f2.projectPath), () => create(f2, 'sel-5b', { excludes: ['shared/one/draft.mjs'] }))
    t.ok('a consumer exclusion inside a link is not copied', !(await exists(path.join(ws2.path, 'shared/one/draft.mjs'))))
    t.ok('the rest is', await exists(path.join(ws2.path, 'shared/one/index.mjs')))
  }

  t.section('6. nested links: a known owner is recursed into, an unknown one refused')
  {
    const f = await engineFixture()
    const o = await owner()
    const other = await owner()
    await fs.symlink(path.join(other, 'modules/one'), path.join(o, 'modules/linked'))
    await fs.symlink(path.join(o, 'modules'), path.join(f.projectPath, 'shared'))
    const ws = await withProjects(await projects(o, other, f.projectPath), () => create(f, 'sel-6', {}))
    t.ok('the nested link carries its own owner\'s selection', await exists(path.join(ws.path, 'shared/linked/index.mjs')))
    t.ok('without that owner\'s ignored output', !(await exists(path.join(ws.path, 'shared/linked/build'))))
    const refused = await withProjects(await projects(o, f.projectPath), () => create(f, 'sel-6b', {})).then(() => null, (e) => e)
    t.eq('an unknown nested owner is refused', refused?.code, 'MATERIALIZE_UNAUTHORIZED')
  }

  t.section('7. delivery reads the live checkout through the same selection')
  {
    const setup = async () => {
      const f = await engineFixture()
      const o = await owner()
      await fs.symlink(path.join(o, 'modules'), path.join(f.projectPath, 'shared'))
      const known = await projects(o, f.projectPath)
      const workspace = await withProjects(known, () => create(f, `sel-7-${Math.random().toString(16).slice(2, 8)}`, {}))
      const baseline = await baselineOf(workspace.path)
      await fs.writeFile(path.join(workspace.path, 'source.txt'), 'application edit\n')
      const fp = await fingerprint(workspace.path, { baseline, baseCommit: workspace.baseCommit })
      const dir = await temp('sel-delivery-')
      await fs.mkdir(path.join(dir, 'artifacts'), { recursive: true })
      const args = { workspace, workspacePath: workspace.path, baseCommit: workspace.baseCommit, baseline, fingerprint: fp, revision: fp.fingerprint, runDir: dir }
      const receipt = await worktreeDiffDelivery.deliver({ ...args, action: 'worktree-diff' })
      return { f, o, known, deliver: () => withProjects(known, () => applyToSource({ ...args, receipt })) }
    }
    const ok = await setup()
    const delivered = await ok.deliver()
    t.eq('delivered although the owner has ignored build output and dependencies', delivered.application.state, 'complete')
    t.eq('the application edit landed', await fs.readFile(path.join(ok.f.projectPath, 'source.txt'), 'utf8'), 'application edit\n')

    const added = await setup()
    await write(path.join(added.o, 'modules/one/new-source.mjs'), 'someone else\'s new file')
    // Drift outside the patch is applied beside (source-delivery.mjs); the new
    // owner file must still be SEEN as drift, which `composed` records.
    const beside = (await added.deliver()).application
    t.eq('delivered beside the drift', beside.state, 'complete', beside.error)
    t.ok('a newly added, selected owner file is still drift', (beside.composed?.paths ?? []).some((p) => p.endsWith('one/new-source.mjs')), JSON.stringify(beside.composed?.paths))

    const ignoredOnly = await setup()
    await write(path.join(ignoredOnly.o, 'modules/one/build/another.js'), 'more generated output')
    t.eq('new ignored output is not drift', (await ignoredOnly.deliver()).application.state, 'complete')

    const rules = await setup()
    await fs.appendFile(path.join(rules.o, '.gitignore'), `*.tmp${NL}`)
    const refused = await rules.deliver()
    t.eq('a changed owner rule file refuses delivery', refused.application.state, 'selection-rules-changed')
    t.ok('naming the rule file', (refused.application.error ?? '').includes('.gitignore'), refused.application.error)
    t.eq('and nothing was written', await fs.readFile(path.join(rules.f.projectPath, 'source.txt'), 'utf8'), 'original\n')

    const newRule = await setup()
    await write(path.join(newRule.o, 'modules/one/.gitignore'), `draft.mjs${NL}`)
    t.eq('a NEW rule file is a change like an edited one', (await newRule.deliver()).application.state, 'selection-rules-changed')

    // The consumer's index still tracks a file under a
    // path that has since become a link, and the link's owner ignores it. The
    // snapshot leaves it out (owner selection); delivery must not read the
    // consumer's stale index entry there as an added file.
    {
      const f = await engineFixture()
      const o = await owner()
      await write(path.join(f.projectPath, 'shared/one/stale.lock'), '')
      await git(f.projectPath, 'add', '-A'); await git(f.projectPath, 'commit', '-qm', 'shared was a directory once')
      await fs.rm(path.join(f.projectPath, 'shared'), { recursive: true })
      await fs.appendFile(path.join(o, '.gitignore'), `stale.lock${NL}`)
      await git(o, 'add', '.gitignore'); await git(o, 'commit', '-qm', 'ignore the lock')
      await write(path.join(o, 'modules/one/stale.lock'), '')
      await fs.symlink(path.join(o, 'modules'), path.join(f.projectPath, 'shared'))
      const known = await projects(o, f.projectPath)
      const workspace = await withProjects(known, () => create(f, `sel-7b-${Math.random().toString(16).slice(2, 8)}`, {}))
      t.ok('the owner-ignored file is not in the snapshot', !await exists(path.join(workspace.path, 'shared/one/stale.lock')))
      const baseline = await baselineOf(workspace.path)
      await fs.writeFile(path.join(workspace.path, 'source.txt'), 'application edit\n')
      const fp = await fingerprint(workspace.path, { baseline, baseCommit: workspace.baseCommit })
      const dir = await temp('sel-delivery-')
      await fs.mkdir(path.join(dir, 'artifacts'), { recursive: true })
      const args = { workspace, workspacePath: workspace.path, baseCommit: workspace.baseCommit, baseline, fingerprint: fp, revision: fp.fingerprint, runDir: dir }
      const receipt = await worktreeDiffDelivery.deliver({ ...args, action: 'worktree-diff' })
      const out = await withProjects(known, () => applyToSource({ ...args, receipt }))
      t.eq('a stale consumer index entry under a link is not drift', out.application.state, 'complete', out.application.error)
    }
  }

  t.section('8. the known projects are the ones the panel resolves')
  {
    const o = await owner()
    const lookalike = await temp('sel-lookalike-')
    const dir = await projects(o)
    await fs.mkdir(path.join(dir, 'not-a-repo-project'))
    await fs.symlink(lookalike, path.join(dir, 'lookalike'))
    const roots = await knownProjectRoots(dir)
    t.ok('a linked project resolves to its repository root', roots.has(o))
    t.eq('nothing else counts', roots.size, 1)
    await fs.symlink(PANEL_ROOT, path.join(dir, 'panel-project'))
    t.ok('the panel\'s own checkout is never a known project', !(await knownProjectRoots(dir)).has(await fs.realpath(PANEL_ROOT)))
  }

  t.section('9. a link to a FILE carries it only if its owner would (audit I1)')
  {
    const f = await engineFixture()
    const o = await owner()
    await write(path.join(o, '.env'), 'SECRET=1\n')
    await fs.appendFile(path.join(o, '.gitignore'), `.env${NL}`)
    await fs.symlink(path.join(o, 'unrelated.txt'), path.join(f.projectPath, 'tracked-link.txt'))
    await fs.symlink(path.join(o, '.env'), path.join(f.projectPath, 'env-link'))
    const ws = await withProjects(await projects(f.projectPath, o), () => create(f, 'sel-9', {}))
    t.ok('a link to a tracked file becomes that file', await exists(path.join(ws.path, 'tracked-link.txt')))
    t.ok('a link to a file the owner ignores carries nothing', !(await exists(path.join(ws.path, 'env-link'))))
    t.ok('and says why', ws.symlinks.selection.skipped.some((s) => s.path === 'env-link' && s.reason === 'owner-ignored file'), JSON.stringify(ws.symlinks.selection.skipped))
    t.ok('the file target\'s owner is recorded', ws.symlinks.selection.owners.some((w) => w.path === 'tracked-link.txt' && w.owner === o))
  }

  t.section('10. forbidden roots refuse a target whoever owns it')
  {
    const f = await engineFixture()
    const o = await owner()
    // A "home" inside the owner: owned by a known project, still forbidden.
    const home = path.join(o, 'home'); await write(path.join(home, '.ssh', 'id'), 'key'); await git(o, 'add', '-A'); await git(o, 'commit', '-qm', 'home')
    await fs.symlink(path.join(home, '.ssh'), path.join(f.projectPath, 'keys'))
    const known = await projects(f.projectPath, o)
    const refused = await withProjects(known, () => create(f, 'sel-10', {})).then(() => null, (e) => e)
    t.ok('a directory-shaped link into the owner is fine by itself', refused === null || refused.code !== 'MATERIALIZE_FORBIDDEN', refused?.message)
    const roots = await forbiddenRoots({ home, projectsDir: known, panelRoot: path.join(o, 'panel'), mountinfo: path.join(o, 'mountinfo') })
    await write(path.join(o, 'mountinfo'), `1 2 0:1 / ${path.join(o, 'container')} rw,relatime,idmapped shared:1 - xfs /dev/x rw${NL}2 3 0:2 / /plain rw,relatime shared:2 - xfs /dev/y rw${NL}`)
    const withMounts = await forbiddenRoots({ home, projectsDir: known, panelRoot: path.join(o, 'panel'), mountinfo: path.join(o, 'mountinfo') })
    t.ok('the home is forbidden', roots.has(home))
    t.ok('the panel root is forbidden', [...roots].some((r) => r.endsWith('/panel')))
    t.ok('an idmapped mount is forbidden', [...withMounts].some((r) => r.endsWith('/container')), JSON.stringify([...withMounts]))
    t.ok('an ordinary mount is not', ![...withMounts].includes('/plain'))
    const authorize = authorizer({ known: new Set([o]), forbidden: roots })
    const inside = await authorize({ owner: o, resolved: path.join(home, '.ssh'), path: 'keys' }).then(() => null, (e) => e)
    t.eq('a target inside a forbidden root is refused although its owner is known', inside?.code, 'MATERIALIZE_FORBIDDEN')
    const containing = await authorize({ owner: o, resolved: o, path: 'all' }).then(() => null, (e) => e)
    t.eq('a target containing a forbidden root is refused', containing?.code, 'MATERIALIZE_FORBIDDEN')
    const beside = await authorize({ owner: o, resolved: path.join(o, 'modules'), path: 'shared' }).then(() => null, (e) => e)
    t.eq('a sibling is not', beside, null)
  }

  t.section('11. darwin injected: no /proc is read, mount discovery is not applicable, the roots still hold')
  {
    const o = await temp('sel-darwin-')
    const home = path.join(o, 'home')
    const projectsDir = path.join(o, 'projects')
    await write(path.join(home, '.ssh', 'id'), 'key')
    await fs.mkdir(path.join(projectsDir, 'production.example'), { recursive: true })
    const reads = []
    const spy = async (file) => { reads.push(String(file)); return '' }
    const darwin = platformFor('darwin', { readFile: spy, exec: async () => ({ ok: false, code: 1, stdout: '', error: 'not a mac' }) })
    const report = await forbiddenRootsReport({ home, projectsDir, panelRoot: path.join(o, 'panel'), prefixes: ['production'], platform: darwin })
    t.eq('mount discovery is reported as not applicable', report.mounts.status, 'not-applicable')
    t.eq('and nothing under /proc was read', reads.filter((f) => f.startsWith('/proc')), [])
    t.ok('the home is forbidden', report.roots.has(await fs.realpath(home)))
    t.ok('the panel root is forbidden', [...report.roots].some((r) => r.endsWith('/panel')))
    t.ok('a protected prefix under the projects root is forbidden', [...report.roots].some((r) => r.endsWith('/production.example')))
    const authorize = authorizer({ known: new Set([o]), forbidden: report.roots })
    const inside = await authorize({ owner: o, resolved: path.join(home, '.ssh'), path: 'keys' }).then(() => null, (e) => e)
    t.eq('a target inside the home is refused', inside?.code, 'MATERIALIZE_FORBIDDEN')
    const linuxReads = []
    const linux = platformFor('linux', { readFile: async (file) => { linuxReads.push(String(file)); return '' } })
    const linuxReport = await forbiddenRootsReport({ home, projectsDir, panelRoot: path.join(o, 'panel'), prefixes: ['production'], platform: linux })
    t.eq('on linux the default table is the mount table, read', [linuxReport.mounts.status, linuxReads], ['read', ['/proc/self/mountinfo']])
  }

  await cleanupFixtures?.()
  await Promise.all(temps.map((d) => fs.rm(d, { recursive: true, force: true })))
}
