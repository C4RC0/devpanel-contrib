import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { worktreeDiffDelivery, gitWorktreeProvider } from '../server/runtime/launch.mjs'
import { baselineOf, fingerprint } from '../server/runtime/fingerprint.mjs'

export const name = 'delivery — baseline-bound, binary-complete, verified by reconstruction'

const run = promisify(execFile)
const NL = String.fromCharCode(10)
const temps = []
const temp = async (p) => { const d = await fs.mkdtemp(path.join(os.tmpdir(), p)); temps.push(d); return d }

/** A project with a tracked text file, a tracked file to delete, and an ignored file. */
async function project () {
  const dir = await temp('delivery-proj-')
  await run('git', ['-C', dir, 'init', '-q', '-b', 'main'])
  await run('git', ['-C', dir, 'config', 'user.email', 't@example.invalid'])
  await run('git', ['-C', dir, 'config', 'user.name', 'T'])
  await fs.writeFile(path.join(dir, 'source.txt'), 'original' + NL)
  await fs.writeFile(path.join(dir, 'doomed.txt'), 'to be deleted' + NL)
  await fs.writeFile(path.join(dir, '.gitignore'), 'generated.txt' + NL)
  await run('git', ['-C', dir, 'add', '-A'])
  await run('git', ['-C', dir, 'commit', '-qm', 'base'])
  return dir
}

async function candidate () {
  const projectPath = await project()
  const runDir = await temp('delivery-run-')
  await fs.mkdir(path.join(runDir, 'artifacts'), { recursive: true })
  const ws = await gitWorktreeProvider.create({ projectPath, runId: 'r1', root: await temp('delivery-ws-') })
  const baseline = await baselineOf(ws.path)
  return { projectPath, runDir, ws, baseline }
}

const deliver = async ({ ws, baseline, runDir }, revisionOverride = null) => {
  const fp = await fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline })
  const receipt = await worktreeDiffDelivery.deliver({
    action: 'worktree-diff',
    revision: revisionOverride ?? fp.fingerprint,
    fingerprint: fp,
    baseCommit: ws.baseCommit,
    baseline,
    workspacePath: ws.path,
    runDir
  })
  const patch = await fs.readFile(path.join(runDir, receipt.artifactRef), 'utf8')
  return { fp, receipt, patch }
}

export default async function (t) {
  t.section('1. a change the author committed inside the worktree is still delivered')
  {
    const c = await candidate()
    await fs.writeFile(path.join(c.ws.path, 'source.txt'), 'changed and committed' + NL)
    await run('git', ['-C', c.ws.path, 'commit', '-qam', 'author committed'])
    const { receipt, patch } = await deliver(c)
    t.ok('the patch is not empty', receipt.bytes > 0, `${receipt.bytes} bytes`)
    t.ok('and carries the committed change', patch.includes('+changed and committed'))
    t.eq('reconstruction verified', receipt.reconstruction.verified, true, receipt.reconstruction.detail)
  }

  t.section('2. binary content, deletions and changed ignored files are captured')
  {
    const c = await candidate()
    const bytes = Buffer.from([0, 1, 2, 255, 254, 0, 10, 13, 0])
    await fs.writeFile(path.join(c.ws.path, 'binary.dat'), bytes)
    await fs.rm(path.join(c.ws.path, 'doomed.txt'))
    await fs.writeFile(path.join(c.ws.path, 'generated.txt'), 'ignored by git, counted by the fingerprint' + NL)
    const { fp, receipt, patch } = await deliver(c)
    t.ok('the fingerprint counted the ignored file', fp.entries.some((e) => e.path === 'generated.txt' && e.status === 'added'))
    t.ok('binary payload is present', patch.includes('GIT binary patch'), patch.split(NL).find((l) => l.includes('binary')))
    t.ok('the deletion is present', patch.includes('deleted file mode'))
    t.ok('the ignored file is present', patch.includes('generated.txt'))
    t.eq('reconstruction verified', receipt.reconstruction.verified, true, receipt.reconstruction.detail)
    t.eq('the rebuilt fingerprint equals the candidate', receipt.reconstruction.fingerprint, fp.fingerprint)
  }

  t.section('3. an unchanged candidate delivers an empty, verified patch')
  {
    const c = await candidate()
    const { receipt } = await deliver(c)
    t.eq('zero bytes', receipt.bytes, 0)
    t.eq('still verified', receipt.reconstruction.verified, true)
  }

  t.section('4. a patch that does not rebuild the expected revision is reported, not trusted')
  {
    const c = await candidate()
    await fs.writeFile(path.join(c.ws.path, 'source.txt'), 'edited' + NL)
    const { receipt } = await deliver(c, 'sha256:' + '0'.repeat(64))
    t.eq('not verified', receipt.reconstruction.verified, false)
    t.ok('the detail names what differs', /differs at \d+ path/.test(receipt.reconstruction.detail ?? ''), receipt.reconstruction.detail)
    t.eq('the expected revision is recorded', receipt.reconstruction.expected, 'sha256:' + '0'.repeat(64))
  }

  t.section('4b. content pre-staged in the worktree index outside the fingerprint scope never reaches the patch')
  {
    const c = await candidate()
    await fs.writeFile(path.join(c.ws.path, 'source.txt'), 'legit' + NL)
    // Something staged an excluded path directly into the worktree's index —
    // invisible to the fingerprint, and to a reconstruction that shares its scope.
    await fs.mkdir(path.join(c.ws.path, 'node_modules'), { recursive: true })
    await fs.writeFile(path.join(c.ws.path, 'node_modules', 'smuggled.js'), 'nobody reviewed this' + NL)
    await run('git', ['-C', c.ws.path, 'add', '--force', 'node_modules/smuggled.js'])
    const { receipt, patch } = await deliver(c)
    t.ok('the smuggled path is not in the patch', !patch.includes('smuggled'))
    t.ok('the legitimate change is', patch.includes('+legit'))
    t.eq('reconstruction verified', receipt.reconstruction.verified, true, receipt.reconstruction.detail)
    t.eq('and the touched set matches the candidate exactly', receipt.reconstruction.paths.extra.length + receipt.reconstruction.paths.missing.length, 0)
  }

  t.section('4c. a patch touching a path outside the candidate is rejected by name')
  {
    const c = await candidate()
    await fs.writeFile(path.join(c.ws.path, 'source.txt'), 'x' + NL)
    const { fp, receipt } = await deliver(c)
    // Tamper with the artifact after the fact: add a hunk for a file the fingerprint never saw.
    const file = path.join(c.runDir, receipt.artifactRef)
    const extra = ['diff --git a/extra.txt b/extra.txt', 'new file mode 100644', 'index 0000000..9daeafb', '--- /dev/null', '+++ b/extra.txt', '@@ -0,0 +1 @@', '+smuggled', ''].join(NL)
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')) + extra)
    const { verifyReconstruction } = await import('../server/runtime/launch.mjs')
    const check = await verifyReconstruction({ workspacePath: c.ws.path, baseCommit: c.ws.baseCommit, baseline: c.baseline, patchFile: file, expected: fp.fingerprint, expectedPaths: new Set(['source.txt']) })
    t.eq('not verified', check.verified, false)
    t.ok('the extra path is named', /outside the fingerprinted candidate: extra.txt/.test(check.detail ?? ''), check.detail)
  }

  t.section('4d. a rename is delivered as a deletion and an addition, and verifies')
  {
    const c = await candidate()
    await fs.rename(path.join(c.ws.path, 'source.txt'), path.join(c.ws.path, 'renamed.txt'))
    const { fp, receipt, patch } = await deliver(c)
    t.ok('the fingerprint records both paths', fp.entries.some((e) => e.path === 'source.txt' && e.status === 'deleted') && fp.entries.some((e) => e.path === 'renamed.txt' && e.status === 'added'))
    t.ok('the patch has no rename header', !patch.includes('rename from'))
    t.eq('reconstruction verified', receipt.reconstruction.verified, true, receipt.reconstruction.detail)
    t.eq('both paths were touched, nothing else', receipt.reconstruction.paths.extra.length + receipt.reconstruction.paths.missing.length, 0)
  }

  t.section('4e. permission bits Git cannot carry never make a candidate unrebuildable')
  {
    const projectPath = await project()
    await fs.writeFile(path.join(projectPath, 'private.sh'), 'echo private' + NL, { mode: 0o600 })
    await run('git', ['-C', projectPath, 'add', '-A'])
    await run('git', ['-C', projectPath, 'commit', '-qm', 'a 0600 file, as a materialized copy would be'])
    const runDir = await temp('delivery-run-')
    await fs.mkdir(path.join(runDir, 'artifacts'), { recursive: true })
    const ws = await gitWorktreeProvider.create({ projectPath, runId: 'r1', root: await temp('delivery-ws-') })
    await fs.chmod(path.join(ws.path, 'private.sh'), 0o600)
    const baseline = await baselineOf(ws.path)
    const c = { projectPath, runDir, ws, baseline }
    const before = await fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline })
    await fs.writeFile(path.join(ws.path, 'source.txt'), 'edited beside a 0600 file' + NL)
    const { fp, receipt } = await deliver(c)
    t.eq('the untouched 0600 file is not a change', fp.entries.find((e) => e.path === 'private.sh')?.status, 'unchanged')
    t.eq('reconstruction verified although the rebuilt file checks out as 0644', receipt.reconstruction.verified, true, receipt.reconstruction.detail)
    await fs.chmod(path.join(ws.path, 'source.txt'), 0o755)
    const exec = await fingerprint(ws.path, { baseCommit: ws.baseCommit, baseline })
    t.ok('the executable bit still changes the fingerprint', exec.fingerprint !== fp.fingerprint && exec.fingerprint !== before.fingerprint)
    t.eq('and is recorded as Git would', exec.entries.find((e) => e.path === 'source.txt')?.mode, '000755')
    const { receipt: execReceipt } = await deliver(c)
    t.eq('a mode change delivers and verifies', execReceipt.reconstruction.verified, true, execReceipt.reconstruction.detail)
  }

  t.section('4f. a change to nothing but the executable bit is staged, delivered and verified')
  {
    const c = await candidate()
    await fs.chmod(path.join(c.ws.path, 'source.txt'), 0o755)
    const { fp, receipt, patch } = await deliver(c)
    t.eq('the fingerprint calls it modified', fp.entries.find((e) => e.path === 'source.txt')?.status, 'modified')
    t.ok('the patch carries the mode', /new mode 100755/.test(patch))
    t.eq('reconstruction verified', receipt.reconstruction.verified, true, receipt.reconstruction.detail)
  }

  t.section('5. no temporary worktree is left behind')
  {
    const c = await candidate()
    await fs.writeFile(path.join(c.ws.path, 'source.txt'), 'x' + NL)
    await deliver(c)
    const { stdout } = await run('git', ['-C', c.projectPath, 'worktree', 'list'])
    t.ok('only the run worktree remains registered', !stdout.includes('reconstruct'), stdout.trim().split(NL).join(' | '))
  }

  await Promise.all(temps.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})))
}
