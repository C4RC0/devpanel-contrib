import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { gitWorktreeProvider, worktreeDiffDelivery } from '../server/runtime/launch.mjs'
import { candidateDiff } from '../server/runtime/diff.mjs'
import { captureIntegrity, integrityChanges } from '../server/runtime/integrity.mjs'
import { fingerprint, baselineOf } from '../server/runtime/fingerprint.mjs'
import { engineFixture } from './fakes/fixture.mjs'

const exec = promisify(execFile)
const git = async (dir, ...args) => (await exec('git', ['-C', dir, ...args])).stdout
const NL = String.fromCharCode(10)

export const name = 'engine Git context — the host never follows a seat-writable .git entry'

const temps = []
const temp = async (prefix) => { const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix)); temps.push(d); return d }
const exists = (p) => fs.lstat(p).then(() => true, () => false)

/**
 * What a seat could do inside its worktree: replace the `.git` file with a
 * repository of its own whose configuration runs commands. Every hook writes a
 * marker OUTSIDE the worktree, where only host execution could put it.
 */
async function plant (worktree, markers) {
  await fs.rm(path.join(worktree, '.git'), { force: true })
  await git(worktree, 'init', '-q')
  const cmd = (name) => `sh -c 'touch ${path.join(markers, name)}; cat'`
  await git(worktree, 'config', 'core.fsmonitor', `sh -c 'touch ${path.join(markers, 'fsmonitor')}'`)
  await git(worktree, 'config', 'filter.evil.clean', cmd('filter'))
  await git(worktree, 'config', 'core.hooksPath', path.join(worktree, 'hooks'))
  await fs.writeFile(path.join(worktree, '.gitattributes'), '* filter=evil\n')
}

async function provision () {
  const f = await engineFixture()
  const ws = await gitWorktreeProvider.create({ projectPath: f.projectPath, runId: `eg-${Math.random().toString(16).slice(2, 8)}`, root: f.issuePath, policy: { base: 'head' } })
  return { f, ws }
}

export default async function (t) {
  t.section('1. provisioning records the git directory before any seat runs')
  {
    const { f, ws } = await provision()
    const common = await fs.realpath(path.join(f.projectPath, '.git'))
    t.ok('the git directory lies in the source repository\'s worktrees/', ws.gitDir?.startsWith(path.join(common, 'worktrees') + path.sep), ws.gitDir)
    t.eq('the .git entry written at provisioning is recorded', ws.gitEntry, await fs.readFile(path.join(ws.path, '.git'), 'utf8'))
  }

  t.section('2. a replaced .git entry executes nothing on the host')
  {
    const { ws } = await provision()
    const markers = await temp('eg-markers-')
    const baseline = await baselineOf(ws.path)
    const before = await captureIntegrity(ws)
    await fs.writeFile(path.join(ws.path, 'source.txt'), 'candidate edit\n')
    await plant(ws.path, markers)

    const diff = await candidateDiff(ws.path, { baseCommit: ws.baseCommit, gitDir: ws.gitDir })
    t.ok('the reviewer diff still shows the edit', diff.text.includes('candidate edit'))
    const fp = await fingerprint(ws.path, { baseline, baseCommit: ws.baseCommit })
    const runDir = await temp('eg-run-')
    await fs.mkdir(path.join(runDir, 'artifacts'))
    const receipt = await worktreeDiffDelivery.deliver({ action: 'worktree-diff', revision: fp.fingerprint, fingerprint: fp, baseCommit: ws.baseCommit, baseline, workspacePath: ws.path, workspace: ws, runDir })
    t.eq('the patch still reconstructs the candidate', receipt.reconstruction?.verified, true)
    const after = await captureIntegrity(ws)
    t.eq('no planted command ran during diff, patch, reconstruction or capture', await fs.readdir(markers), [])
    const changes = integrityChanges(before, after)
    t.eq('integrity reports the replaced entry as a repository change', changes.head, true)
    t.ok('the recorded entry names what it became', /not a file/.test(after.repository?.entry ?? ''), after.repository?.entry)
  }

  t.section('3. contrast: discovery through the entry runs the planted configuration')
  {
    const { ws } = await provision()
    const markers = await temp('eg-markers-')
    const baseline = await baselineOf(ws.path)
    await fs.writeFile(path.join(ws.path, 'source.txt'), 'candidate edit\n')
    await plant(ws.path, markers)
    // The spelling the engine used before this change (and still uses for a
    // run provisioned without a recorded directory): discovery through the
    // worktree, staging with a throwaway index.
    const index = path.join(await temp('eg-index-'), 'index')
    await exec('git', ['-C', ws.path, 'add', '-A'], { env: { ...process.env, GIT_INDEX_FILE: index } }).catch(() => null)
    t.ok('discovery through the replaced entry executes the planted configuration (what the fix prevents)', (await fs.readdir(markers)).length > 0, (await fs.readdir(markers)).join(','))
  }

  t.section('4. a repository created inside the worktree is a change of its own (R9-3)')
  {
    const { ws } = await provision()
    const before = await captureIntegrity(ws)
    t.eq('the provisioned tree has no nested repository', before.nestedGit, [])
    t.eq('a repeat capture reports nothing', integrityChanges(before, await captureIntegrity(ws)).nested, [])
    await fs.mkdir(path.join(ws.path, 'vendor/sub'), { recursive: true })
    await git(path.join(ws.path, 'vendor/sub'), 'init', '-q')
    const after = await captureIntegrity(ws)
    const changes = integrityChanges(before, after)
    t.eq('the planted repository is named', changes.nested, ['vendor/sub/.git'])
    t.eq('and counts as a change', changes.changed, true)
  }

  t.section('5. a failed reconstruction removal leaves no registration behind')
  {
    const { f, ws } = await provision()
    const listed = await git(f.projectPath, 'worktree', 'list', '--porcelain')
    t.ok('only the run worktree is registered after delivery verification', !/devpanel-reconstruct-|devpanel-commit-verify-/.test(listed), listed)
    t.ok('the run worktree itself is', listed.includes(ws.path) || listed.includes(await fs.realpath(ws.path)))
  }

  t.section('6. the reviewer diff follows the fingerprint, not a .gitignore the writer adds (audit I10)')
  {
    const { ws } = await provision()
    await fs.writeFile(path.join(ws.path, 'evil.js'), 'process.exit(1)' + NL)
    await fs.writeFile(path.join(ws.path, '.gitignore'), 'evil.js' + NL)
    await fs.mkdir(path.join(ws.path, 'node_modules', 'dep'), { recursive: true })
    await fs.writeFile(path.join(ws.path, 'node_modules', 'dep', 'index.js'), 'dep' + NL)
    const diff = await candidateDiff(ws.path, { baseCommit: ws.baseCommit, gitDir: ws.gitDir })
    t.ok('the ignored new file is in the diff', diff.text.includes('diff --git a/evil.js b/evil.js') && diff.text.includes('process.exit(1)'), diff.text.slice(0, 400))
    t.ok('marked as matched by an ignore rule', /^# evil\.js: matched by an ignore rule/m.test(diff.text))
    t.ok('the .gitignore itself is there, unmarked', diff.text.includes('diff --git a/.gitignore b/.gitignore') && !/^# \.gitignore:/m.test(diff.text))
    t.ok('node_modules stays out, as it is out of the fingerprint', !diff.text.includes('node_modules/dep'))
  }

  t.section('7. a .gitattributes the writer adds does not rewrite bytes on the way into the engine (audit I11)')
  {
    const { ws } = await provision()
    const baseline = await baselineOf(ws.path)
    await fs.writeFile(path.join(ws.path, '.gitattributes'), '* text eol=lf' + NL)
    await fs.writeFile(path.join(ws.path, 'crlf.txt'), 'a\r\nb\r\n')
    const fp = await fingerprint(ws.path, { baseline, baseCommit: ws.baseCommit })
    const runDir = await temp('eg-run-')
    await fs.mkdir(path.join(runDir, 'artifacts'))
    const receipt = await worktreeDiffDelivery.deliver({ action: 'commit', revision: fp.fingerprint, fingerprint: fp, baseCommit: ws.baseCommit, baseline, workspacePath: ws.path, workspace: ws, runDir })
    t.eq('the patch reconstructs the candidate byte for byte', receipt.reconstruction?.verified, true, receipt.reconstruction?.detail)
    const stored = await exec('git', ['-C', ws.path, 'show', `${receipt.commit}:crlf.txt`]).then((r) => r.stdout)
    t.eq('the committed blob keeps its CRLF bytes', stored, 'a\r\nb\r\n')
  }

  await Promise.all(temps.map((d) => fs.rm(d, { recursive: true, force: true })))
}
