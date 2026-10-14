import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { gitWorktreeProvider, worktreeDiffDelivery } from '../server/runtime/launch.mjs'
import { baselineOf, escapingLinks, fingerprint } from '../server/runtime/fingerprint.mjs'
import { captureIntegrity } from '../server/runtime/integrity.mjs'
import { resolvePlaybook, loadConfig } from '../server/config/load.mjs'
import { sandbox } from './helpers.mjs'

export const name = 'base policy — what a worktree is cut from is a decision, recorded, never HEAD by accident'

const run = promisify(execFile)
const NL = String.fromCharCode(10)
const temps = []
const temp = async (p) => { const d = await fs.mkdtemp(path.join(os.tmpdir(), p)); temps.push(d); return d }

/** A committed project whose checkout has since diverged: a tracked edit, an untracked file, a symlink. */
async function project ({ dirty = true } = {}) {
  const dir = await temp('base-proj-')
  await run('git', ['-C', dir, 'init', '-q', '-b', 'main'])
  await run('git', ['-C', dir, 'config', 'user.email', 't@example.invalid'])
  await run('git', ['-C', dir, 'config', 'user.name', 'T'])
  await fs.mkdir(path.join(dir, 'lib'))
  await fs.writeFile(path.join(dir, 'lib', 'a.txt'), 'committed' + NL)
  await fs.writeFile(path.join(dir, '.gitignore'), 'ignored.txt' + NL)
  await run('git', ['-C', dir, 'add', '-A'])
  await run('git', ['-C', dir, 'commit', '-qm', 'base'])
  if (dirty) {
    await fs.writeFile(path.join(dir, 'lib', 'a.txt'), 'live edit' + NL)          // tracked modification
    await fs.writeFile(path.join(dir, 'live-only.txt'), 'never committed' + NL)  // untracked
    await fs.symlink('/opt/somewhere', path.join(dir, 'linked'))                  // symlink layout
    await fs.writeFile(path.join(dir, 'ignored.txt'), 'ignored' + NL)             // ignored
  }
  return dir
}

export default async function (t) {
  t.section('1. head with a dirty checkout is refused, and says what to do')
  {
    const projectPath = await project()
    let threw = null
    try { await gitWorktreeProvider.create({ projectPath, runId: 'r1', root: await temp('base-ws-'), policy: { base: 'head', requireCleanBase: true } }) } catch (e) { threw = e }
    t.eq('refused', threw?.code, 'DIRTY_BASE')
    t.ok('names the count and the alternatives', /1 tracked path\(s\).*working-tree/.test(threw?.message ?? ''), threw?.message)
    const { stdout } = await run('git', ['-C', projectPath, 'worktree', 'list'])
    t.eq('no worktree was created', stdout.trim().split(NL).length, 1)
  }

  t.section('2. head with a clean checkout cuts from HEAD and records it')
  {
    const projectPath = await project({ dirty: false })
    const ws = await gitWorktreeProvider.create({ projectPath, runId: 'r2', root: await temp('base-ws-'), policy: { base: 'head' } })
    const head = (await run('git', ['-C', projectPath, 'rev-parse', 'HEAD'])).stdout.trim()
    t.eq('base is HEAD', ws.baseCommit, head)
    t.eq('policy recorded', ws.base.policy, 'head')
    t.eq('with zero dirty paths', ws.base.dirtyPaths, 0)
  }

  t.section('3. working-tree snapshots the checkout as it is')
  {
    const projectPath = await project()
    const head = (await run('git', ['-C', projectPath, 'rev-parse', 'HEAD'])).stdout.trim()
    const ws = await gitWorktreeProvider.create({ projectPath, runId: 'r3', root: await temp('base-ws-'), policy: { base: 'working-tree', requireCleanBase: true, symlinks: 'allow' } })
    t.ok('the base is a new commit, not HEAD', ws.baseCommit !== head)
    t.eq('parented on HEAD', (await run('git', ['-C', projectPath, 'rev-parse', `${ws.baseCommit}^`])).stdout.trim(), head)
    t.eq('kept reachable by a ref', (await run('git', ['-C', projectPath, 'rev-parse', ws.base.snapshotRef])).stdout.trim(), ws.baseCommit)
    t.eq('recorded as working-tree with the counts', `${ws.base.policy}:${ws.base.dirtyPaths}:${ws.base.untrackedPaths}`, 'working-tree:1:2')
    t.eq('the worktree has the live edit', await fs.readFile(path.join(ws.path, 'lib', 'a.txt'), 'utf8'), 'live edit' + NL)
    t.eq('and the untracked file', await fs.readFile(path.join(ws.path, 'live-only.txt'), 'utf8'), 'never committed' + NL)
    t.eq('and the symlink, as a symlink', await fs.readlink(path.join(ws.path, 'linked')), '/opt/somewhere')
    t.eq('but not the ignored file', await fs.access(path.join(ws.path, 'ignored.txt')).then(() => true, () => false), false)
    t.eq('the project index was not touched', (await run('git', ['-C', projectPath, 'diff', '--cached', '--stat'])).stdout.trim(), '')

    // A candidate against that base contains only what the author changed,
    // not the pre-existing divergence; and it reconstructs.
    const baseline = await baselineOf(ws.path)
    await fs.writeFile(path.join(ws.path, 'lib', 'a.txt'), 'author edit' + NL)
    const fp = await fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline })
    const runDir = await temp('base-run-'); await fs.mkdir(path.join(runDir, 'artifacts'))
    const receipt = await worktreeDiffDelivery.deliver({ action: 'worktree-diff', revision: fp.fingerprint, fingerprint: fp, baseCommit: ws.baseCommit, baseline, workspacePath: ws.path, runDir })
    const patch = await fs.readFile(path.join(runDir, receipt.artifactRef), 'utf8')
    t.ok('the patch is the author edit against the live state', patch.includes('-live edit') && patch.includes('+author edit'))
    t.ok('and nothing else', !patch.includes('live-only'), patch.split(NL).filter((l) => l.startsWith('diff')).join(' | '))
    t.eq('reconstruction verified against the snapshot base', receipt.reconstruction.verified, true, receipt.reconstruction.detail)
  }

  t.section('3e. working-tree leaves out what the policy excludes: runtime state, secrets, symlinked dependency trees')
  {
    const projectPath = await project()
    await fs.mkdir(path.join(projectPath, 'runtime', 'log'), { recursive: true })
    await fs.writeFile(path.join(projectPath, 'runtime', 'log', 'today.log'), 'noise' + NL)
    await fs.mkdir(path.join(projectPath, 'config'))
    await fs.writeFile(path.join(projectPath, 'config', 'secret.json'), '{"s":1}' + NL)
    await fs.mkdir(path.join(projectPath, 'mod'))
    await fs.symlink('/opt/somewhere/node_modules', path.join(projectPath, 'mod', 'node_modules'))
    const ws = await gitWorktreeProvider.create({ projectPath, runId: 'r3e', root: await temp('base-ws-'), policy: { base: 'working-tree', requireCleanBase: true, symlinks: 'allow', excludes: ['runtime', 'config', '**/node_modules'] } })
    const exists = (p) => fs.access(path.join(ws.path, p)).then(() => true, () => false)
    t.eq('the live edit is there', await fs.readFile(path.join(ws.path, 'lib', 'a.txt'), 'utf8'), 'live edit' + NL)
    t.eq('runtime state is not', await exists('runtime'), false)
    t.eq('secrets are not', await exists('config'), false)
    t.eq('a symlinked node_modules is not', await exists(path.join('mod', 'node_modules')), false)
    t.ok('so it is not an escaping link either', !(await escapingLinks(ws.path)).some((l) => l.path.includes('node_modules')))
    t.eq('the exclusions are recorded on the base', ws.base.excludes.join(','), 'runtime,config,**/node_modules')
    t.eq('the project index was not touched', (await run('git', ['-C', projectPath, 'diff', '--cached', '--stat'])).stdout.trim(), '')
    t.eq('the project checkout still has its runtime state', await fs.access(path.join(projectPath, 'runtime', 'log', 'today.log')).then(() => true, () => false), true)
  }

  t.section('3b. a symlink pointing outside the worktree is refused by default')
  {
    const projectPath = await project()
    let threw = null
    try { await gitWorktreeProvider.create({ projectPath, runId: 'r3b', root: await temp('base-ws-'), policy: { base: 'working-tree' } }) } catch (e) { threw = e }
    t.eq('refused', threw?.code, 'ESCAPING_SYMLINKS')
    t.ok('naming the link and the alternatives', /linked -> \/opt\/somewhere.*materialize.*allow/.test(threw?.message ?? ''), threw?.message)
    t.eq('no worktree left behind', (await run('git', ['-C', projectPath, 'worktree', 'list'])).stdout.trim().split(NL).length, 1)
    const allowed = await gitWorktreeProvider.create({ projectPath, runId: 'r3c', root: await temp('base-ws-'), policy: { base: 'working-tree', symlinks: 'allow' } })
    t.eq('allow keeps it and records it', `${allowed.symlinks.policy}:${allowed.symlinks.escaping.length}`, 'allow:1')
  }

  t.section('3b2. a link under a path the fingerprint excludes still counts as escaping')
  {
    const projectPath = await project({ dirty: false })
    const outside = await temp('base-outside-nm-')
    await fs.symlink(outside, path.join(projectPath, 'node_modules'))
    await run('git', ['-C', projectPath, 'add', 'node_modules'])
    await run('git', ['-C', projectPath, 'commit', '-qm', 'tracked node_modules link'])
    let threw = null
    try { await gitWorktreeProvider.create({ projectPath, runId: 'r3e', root: await temp('base-ws-'), policy: { base: 'head' } }) } catch (e) { threw = e }
    t.eq('refused', threw?.code, 'ESCAPING_SYMLINKS', threw?.message)
    t.ok('naming node_modules', /node_modules ->/.test(threw?.message ?? ''), threw?.message)
  }

  t.section('3c. materialize copies the link target into the worktree and re-snapshots')
  {
    const projectPath = await project({ dirty: false })
    const outside = await temp('base-outside-')
    await fs.writeFile(path.join(outside, 'module.txt'), 'live source' + NL)
    await fs.symlink(outside, path.join(projectPath, 'modules'))
    const ws = await gitWorktreeProvider.create({ projectPath, runId: 'r3d', root: await temp('base-ws-'), policy: { base: 'working-tree', symlinks: 'materialize' } })
    t.eq('the link was materialized', ws.symlinks.materialized.join(','), 'modules')
    t.eq('as a real directory', (await fs.lstat(path.join(ws.path, 'modules'))).isSymbolicLink(), false)
    t.eq('with the target content', await fs.readFile(path.join(ws.path, 'modules', 'module.txt'), 'utf8'), 'live source' + NL)
    t.eq('the base commit contains the copy', (await run('git', ['-C', projectPath, 'cat-file', '-p', `${ws.baseCommit}:modules/module.txt`])).stdout, 'live source' + NL)
    t.eq('candidate Git index matches the materialized base', (await run('git', ['-C', ws.path, 'diff', '--cached', '--name-only'])).stdout, '')
    const integrity = await captureIntegrity(ws)
    t.ok('tracked-source integrity captures materialized files', integrity.trackedPaths.includes('modules/module.txt') && !integrity.trackedPaths.includes('modules'))
    const baseline = await baselineOf(ws.path)
    const fp = await fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline })
    t.ok('and the worktree is unchanged relative to it', fp.entries.every((e) => e.status === 'unchanged'))
    // Editing the copy changes the candidate, not the live source.
    await fs.writeFile(path.join(ws.path, 'modules', 'module.txt'), 'candidate edit' + NL)
    t.eq('the live file is untouched', await fs.readFile(path.join(outside, 'module.txt'), 'utf8'), 'live source' + NL)
    const fp2 = await fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline })
    t.ok('and the fingerprint moved', fp2.fingerprint !== fp.fingerprint)
  }

  t.section('3d. a symlink is part of the fingerprint by identity, never by what it reaches')
  {
    const dir = await temp('fp-link-')
    const outside = await temp('fp-outside-')
    await fs.writeFile(path.join(outside, 'target.txt'), 'external' + NL)
    await fs.writeFile(path.join(dir, 'own.txt'), 'own' + NL)
    await fs.symlink(path.join(outside, 'target.txt'), path.join(dir, 'link'))
    const baseline = await baselineOf(dir)
    t.ok('the baseline has the link', baseline.has('link'))
    const before = await fingerprint(dir, { baseline })
    await fs.writeFile(path.join(dir, 'link'), 'written through the link' + NL)   // follows the symlink
    const afterWrite = await fingerprint(dir, { baseline })
    t.eq('writing through the link does not change the candidate', afterWrite.fingerprint, before.fingerprint)
    t.eq('but did change the external file', await fs.readFile(path.join(outside, 'target.txt'), 'utf8'), 'written through the link' + NL)
    t.eq('which is exactly why such links are refused at provisioning', (await escapingLinks(dir)).map((l) => l.path).join(','), 'link')
    await fs.rm(path.join(dir, 'link')); await fs.symlink(path.join(outside, 'other.txt'), path.join(dir, 'link'))
    const retargeted = await fingerprint(dir, { baseline })
    t.ok('re-pointing the link changes the fingerprint', retargeted.fingerprint !== before.fingerprint)
    t.eq('recorded as modified with mode link', retargeted.entries.find((e) => e.path === 'link').status + ':' + retargeted.entries.find((e) => e.path === 'link').mode, 'modified:link')
  }

  t.section('4. an explicit commit')
  {
    const projectPath = await project()
    const first = (await run('git', ['-C', projectPath, 'rev-parse', 'HEAD'])).stdout.trim()
    await run('git', ['-C', projectPath, 'commit', '-qam', 'second'])
    const ws = await gitWorktreeProvider.create({ projectPath, runId: 'r4', root: await temp('base-ws-'), policy: { base: { commit: first } } })
    t.eq('cut from the named commit', ws.baseCommit, first)
    t.eq('recorded with its ref', `${ws.base.policy}:${ws.base.ref}`, `commit:${first}`)
  }

  t.section('5. the policy resolves from strategy, playbook and run, in that order')
  {
    const root = await sandbox()
    const def = await resolvePlaybook('implementation', { root })
    t.eq('strategy default is working-tree', `${def.resolved.workspace.base}:${def.resolved.workspace.baseSource}`, 'working-tree:strategy')
    const chosen = await resolvePlaybook('implementation', { root, runOptions: { base: 'head' } })
    t.eq('a run may choose head', `${chosen.resolved.workspace.base}:${chosen.resolved.workspace.baseSource}`, 'head:run')
    t.ok('and the choice is in the config hash', chosen.resolved.configHash !== def.resolved.configHash)
    const bad = await resolvePlaybook('implementation', { root, runOptions: { base: 'yesterday' } })
    t.eq('an unknown base is refused', bad.ok, false)
  }

  t.section('6. project workspace defaults preserve explicit playbook and run choices')
  {
    const config = await loadConfig({ root: await sandbox() })
    config.projects.set('fixture', { id: 'fixture', hash: 'fixture-project', workspace: { base: 'working-tree', symlinks: 'materialize' } })
    const resolve = (runOptions = {}) => resolvePlaybook('analysis', { config, projectId: 'fixture', runOptions })
    const projectDefault = await resolve()
    t.ok('project defaults resolve', projectDefault.ok)
    t.eq('project base is recorded', [projectDefault.resolved.workspace.base, projectDefault.resolved.workspace.baseSource], ['working-tree', 'project'])
    t.eq('project links are materialized', projectDefault.resolved.workspace.symlinks, 'materialize')
    const projectPath = await project()
    const external = await temp('base-framework-')
    await fs.writeFile(path.join(external, 'framework.txt'), 'current framework')
    await fs.rm(path.join(projectPath, 'linked'))
    await fs.symlink(external, path.join(projectPath, 'linked'))
    const ws = await gitWorktreeProvider.create({ projectPath, runId: 'project-default', root: await temp('base-ws-'), policy: projectDefault.resolved.workspace })
    t.eq('dirty checkout can create the candidate with resolved project defaults', ws.base.policy, 'working-tree')
    t.eq('candidate contains the linked framework', await fs.readFile(path.join(ws.path, 'linked/framework.txt'), 'utf8'), 'current framework')
    const explicit = await resolve({ base: 'head', symlinks: 'reject' })
    t.eq('explicit run choices override project defaults', [explicit.resolved.workspace.base, explicit.resolved.workspace.baseSource, explicit.resolved.workspace.symlinks], ['head', 'run', 'reject'])
    config.playbooks.set('analysis', { ...config.playbooks.get('analysis'), workspace: { base: 'head' } })
    const saved = await resolve()
    t.eq('explicit playbook choice overrides project default', [saved.resolved.workspace.base, saved.resolved.workspace.baseSource], ['head', 'playbook'])
    config.projects.set('fixture', { id: 'fixture', hash: 'changed-project', workspace: { base: 'head' } })
    t.ok('project configuration changes invalidate previews', (await resolve()).resolved.configHash !== projectDefault.resolved.configHash)
  }

  t.section('working-tree snapshot commits are a function of their content: the same checkout gives the same base commit')
  {
    // The baseline cache keys on the base commit; a per-run commit could never hit.
    const projectPath = await project()
    const policy = { base: 'working-tree', symlinks: 'allow' }
    const cut = async (runId) => gitWorktreeProvider.create({ projectPath, runId, root: await temp('base-ws-'), policy })
    const first = await cut('det-1')
    await new Promise((resolve) => setTimeout(resolve, 1100))   // a later second must not change it
    const second = await cut('det-2')
    t.eq('two runs on the same checkout and HEAD share the base commit', second.baseCommit, first.baseCommit)
    t.ok('each run keeps its own ref', first.base.snapshotRef !== second.base.snapshotRef)
    await fs.writeFile(path.join(projectPath, 'live-only.txt'), 'changed' + NL)
    t.ok('one changed byte gives another base commit', (await cut('det-3')).baseCommit !== first.baseCommit)
    await fs.writeFile(path.join(projectPath, 'live-only.txt'), 'never committed' + NL)
    t.eq('restored, the commit comes back', (await cut('det-4')).baseCommit, first.baseCommit)
    await run('git', ['-C', projectPath, 'commit', '-q', '--allow-empty', '-m', 'same tree, new HEAD'])
    const moved = await cut('det-5')
    t.ok('the same content on a new HEAD is another base commit', moved.baseCommit !== first.baseCommit)
    t.eq('with the same tree', (await run('git', ['-C', projectPath, 'rev-parse', `${moved.baseCommit}^{tree}`])).stdout.trim(), (await run('git', ['-C', projectPath, 'rev-parse', `${first.baseCommit}^{tree}`])).stdout.trim())
  }

  await Promise.all(temps.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})))
}
