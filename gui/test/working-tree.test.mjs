import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { classifyUntracked, describeBlocking, compositionPaths } from '../server/runtime/working-tree.mjs'
import { inspectLaunchState } from '../server/supervisor-launch-state.mjs'

export const name = 'working tree — what `git add -A` would make of it, read the same way twice'

const exec = promisify(execFile)
const run = async (args, options) => (await exec('git', args, options)).stdout
const NL = String.fromCharCode(10)
const temps = []
const temp = async (p) => { const d = await fs.mkdtemp(path.join(os.tmpdir(), p)); temps.push(d); return d }

async function project () {
  const dir = await temp('worktree-')
  await exec('git', ['-C', dir, 'init', '-q', '-b', 'main'])
  await exec('git', ['-C', dir, 'config', 'user.email', 't@example.invalid'])
  await exec('git', ['-C', dir, 'config', 'user.name', 'T'])
  await fs.writeFile(path.join(dir, 'tracked.txt'), 'committed' + NL)
  await exec('git', ['-C', dir, 'add', '-A'])
  await exec('git', ['-C', dir, 'commit', '-qm', 'base'])
  return dir
}

/** What `git add -A` actually records, so a prediction can be checked against it. */
async function snapshotEntries (dir) {
  const index = path.join(await temp('worktree-index-'), 'index')
  const env = { ...process.env, GIT_INDEX_FILE: index }
  await exec('git', ['-C', dir, 'add', '-A'], { env })
  const { stdout } = await exec('git', ['-C', dir, 'ls-files', '--stage'], { env })
  return stdout.trim().split(NL).filter(Boolean).map((l) => l.split(/\s+/))
}

export default async function (t) {
  t.section('Git composition excludes ignored and configured paths before reading content')
  {
    const dir = await project()
    await fs.writeFile(path.join(dir, '.gitignore'), '*.log\n')
    await fs.writeFile(path.join(dir, 'ignored.log'), 'ignored')
    await fs.writeFile(path.join(dir, '.git/info/exclude'), 'private.env\n')
    await fs.writeFile(path.join(dir, 'private.env'), 'ignored locally')
    await fs.writeFile(path.join(dir, 'staged.log'), 'force-staged but outside snapshot')
    await exec('git', ['-C', dir, 'add', '-f', 'staged.log'])
    await fs.mkdir(path.join(dir, 'runtime'))
    await fs.writeFile(path.join(dir, 'runtime/state'), 'excluded')
    const before = await inspectLaunchState({ projectPath: dir, workspace: { base: 'working-tree', excludes: ['runtime'] } })
    const index = await fs.readFile(path.join(dir, '.git/index'))
    const selected = await compositionPaths({ projectPath: dir, run, tracked: true, excludes: ['runtime'] })
    t.eq('composition matches HEAD-seeded snapshot selection', selected.sort(), ['.gitignore', 'tracked.txt'])
    t.eq('composition leaves source index byte-for-byte intact', await fs.readFile(path.join(dir, '.git/index')), index)
    await fs.writeFile(path.join(dir, 'runtime/state'), 'new runtime state')
    await fs.writeFile(path.join(dir, 'private.env'), 'new ignored state')
    const after = await inspectLaunchState({ projectPath: dir, workspace: { base: 'working-tree', excludes: ['runtime'] } })
    t.eq('excluded and ignored changes do not change launch condition', after.key, before.key)
  }

  t.section('1. a nested repository is a gitlink, and its HEAD is what changes')
  {
    const dir = await project()
    const nested = path.join(dir, 'vendor')
    await fs.mkdir(nested)
    await exec('git', ['-C', nested, 'init', '-q', '-b', 'main'])
    await exec('git', ['-C', nested, 'config', 'user.email', 'n@example.invalid'])
    await exec('git', ['-C', nested, 'config', 'user.name', 'N'])
    await fs.writeFile(path.join(nested, 'a.txt'), 'one' + NL)
    await exec('git', ['-C', nested, 'add', '-A'])
    await exec('git', ['-C', nested, 'commit', '-qm', 'one'])
    const first = (await run(['-C', nested, 'rev-parse', 'HEAD'])).trim()

    const scan = await classifyUntracked({ projectPath: dir, run })
    const entry = scan.entries.find((e) => e[0].startsWith('vendor'))
    t.eq('nothing blocks a nested repository with a commit', scan.blocking.length, 0)
    t.eq('and it is fingerprinted by the commit git would link to', entry?.[2], `gitlink:${first}`)

    // What git actually records, so the prediction is checked rather than asserted.
    const staged = await snapshotEntries(dir)
    const gitlink = staged.find((row) => row[3] === 'vendor')
    t.eq('git records it as a gitlink', gitlink?.[0], '160000')
    t.eq('at exactly that commit', gitlink?.[1], first)

    await fs.writeFile(path.join(nested, 'a.txt'), 'two' + NL)
    await exec('git', ['-C', nested, 'commit', '-aqm', 'two'])
    const moved = await classifyUntracked({ projectPath: dir, run })
    t.ok('a commit inside it changes the fingerprint', moved.entries.find((e) => e[0].startsWith('vendor'))?.[2] !== entry?.[2])

    // The old reading hashed the word "directory" and could not see this at all.
    t.ok('which the directory name alone never could', moved.entries.find((e) => e[0].startsWith('vendor'))?.[2] !== 'directory')
  }

  t.section('2. an unreadable regular file fails closed, rather than being waved through')
  {
    const dir = await project()
    const secret = path.join(dir, 'unreadable.txt')
    await fs.writeFile(secret, 'cannot be read' + NL)
    await fs.chmod(secret, 0o000)
    // Running as root would read it anyway and prove nothing.
    const readable = await fs.readFile(secret).then(() => true, () => false)
    if (readable) t.skip('an unreadable file blocks the snapshot', 'this user can read a 000 file')
    else {
      const scan = await classifyUntracked({ projectPath: dir, run })
      t.eq('it is reported as blocking, not as an entry', [scan.blocking.length, scan.entries.some((e) => e[0] === 'unreadable.txt')], [1, false])
      t.eq('naming the path and the reason', scan.blocking[0].path, 'unreadable.txt')
      t.eq('with the errno on record', scan.blocking[0].code, 'EACCES')
      t.ok('and a sentence that says what it stops', /cannot be snapshotted/.test(describeBlocking(scan.blocking)), describeBlocking(scan.blocking))

      // The launch condition must refuse it: `git add -A` fails on this file, so
      // a run admitted here would die building its base, after paying preflight.
      const condition = await inspectLaunchState({ projectPath: dir, workspace: { base: 'working-tree' }, configHash: 'c' })
      t.eq('the launch condition fails closed', condition.code, 'UNREADABLE_WORKTREE')
      t.ok('saying the base would fail after preflight was paid', /after preflight/.test(condition.blockedReason ?? ''), condition.blockedReason)

      // And the snapshot really would have failed, which is the point.
      let addFailed = false
      try { await snapshotEntries(dir) } catch { addFailed = true }
      t.ok('git add -A does fail on it, so refusing was right', addFailed)

      await fs.chmod(secret, 0o644)
      const clear = await inspectLaunchState({ projectPath: dir, workspace: { base: 'working-tree' }, configHash: 'c' })
      t.eq('and once it is readable the condition clears', clear.code ?? null, null)
    }
  }

  t.section('3. a special file is classified, never read')
  {
    const dir = await project()
    const fifo = path.join(dir, 'pipe')
    const made = await exec('mkfifo', [fifo]).then(() => true, () => false)
    if (!made) t.skip('a fifo is classified rather than read', 'mkfifo unavailable')
    else {
      // git does not list non-regular files at all, which is why this is
      // defensive rather than routine — but a path listed as a file and replaced
      // by a fifo before it is read reaches exactly this branch, and readFile on
      // a fifo does not fail, it blocks forever.
      const listed = (await run(['-C', dir, 'ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean)
      t.ok('git itself does not list a fifo as untracked', !listed.includes('pipe'), listed.join(','))

      const asIfListed = async (args) =>
        args.includes('ls-files') && args.at(-1) === '.' ? 'pipe\0' : run(args)
      const scan = await Promise.race([
        classifyUntracked({ projectPath: dir, run: asIfListed }),
        new Promise((resolve) => setTimeout(() => resolve('blocked on the fifo'), 5000))
      ])
      t.ok('classification returns rather than blocking on it', scan !== 'blocked on the fifo')
      if (scan !== 'blocked on the fifo') {
        t.eq('it is classified, and it blocks the snapshot', [scan.blocking[0]?.path, scan.blocking[0]?.code], ['pipe', 'SPECIAL_FILE'])
        t.ok('saying what it is', /fifo cannot be recorded by git/.test(scan.blocking[0]?.reason ?? ''), scan.blocking[0]?.reason)
        t.eq('and it is not fingerprinted as content', scan.entries.length, 0)
      }
    }
  }

  t.section('4. a symlink is still its target text, and an ordinary file its content')
  {
    const dir = await project()
    await fs.writeFile(path.join(dir, 'plain.txt'), 'hello' + NL)
    await fs.symlink('/somewhere/else', path.join(dir, 'link'))
    await fs.mkdir(path.join(dir, 'sub'))
    await fs.writeFile(path.join(dir, 'sub', 'deep.txt'), 'deep' + NL)
    const scan = await classifyUntracked({ projectPath: dir, run })
    t.eq('nothing blocks an ordinary tree', scan.blocking.length, 0)
    t.eq('files inside a plain directory are listed individually, as git lists them', scan.entries.map((e) => e[0]).sort(), ['link', 'plain.txt', 'sub/deep.txt'])
    const staged = (await snapshotEntries(dir)).map((row) => row[3]).sort()
    t.eq('which is exactly what the snapshot would contain', staged, ['link', 'plain.txt', 'sub/deep.txt', 'tracked.txt'])
  }

  for (const dir of temps) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
}
