import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

/*
 * What `git add -A` would make of the untracked working tree.
 *
 * The `working-tree` base snapshots the checkout as it is, by running `git add
 * -A` into a throwaway index. Anything that reads the tree to decide whether a
 * run may start is therefore answering one question: what would that command
 * produce, and can it produce anything at all?
 *
 * Two implementations of that answer would drift, and the drift has a direction:
 * a reader that is more permissive than the snapshot approves a tree the launch
 * cannot materialise, and the run dies after admission and preflight have
 * already spent. So the classification lives here once, and both the launch
 * condition and the snapshot use it.
 *
 * The cases that matter, none of which a plain readFile handles:
 *
 *  - A nested repository or worktree. git lists the directory and records a
 *    GITLINK to its HEAD commit. Fingerprinting the word "directory" would miss
 *    every change to what the snapshot actually contains.
 *  - An unreadable regular file. `git add -A` fails on it, so a reading that
 *    shrugs and continues approves a snapshot that cannot be built.
 *  - A special file — fifo, socket, device. readFile on a fifo does not fail, it
 *    BLOCKS, and git cannot record one either way.
 *  - A file that disappears mid-scan. The tree moved while being read, so the
 *    reading describes no single state of it.
 */

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

// Git owns ignore and pathspec semantics. Share this selection with snapshot
// admission and destination verification; never discover ignored file contents
// by walking the checkout first.
export const snapshotPathspec = (excludes = []) => ['.', ...excludes.map(p => `:(glob,exclude)${p}`)]

export async function compositionPaths ({ projectPath, run, tracked = false, excludes = [] }) {
  let temporary
  try {
    // The snapshot seeds its private index from HEAD, not the user's index.
    // In particular, a newly force-staged ignored file is absent from that
    // snapshot. Use the identical index basis without adding or hashing files.
    if (tracked) temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-composition-'))
    const options = temporary ? { env: { ...process.env, GIT_INDEX_FILE: path.join(temporary, 'index'), GIT_OPTIONAL_LOCKS: '0' } } : {}
    if (tracked) await run(['-C', projectPath, 'read-tree', 'HEAD'], options)
    return [...new Set((await run(['-C', projectPath, 'ls-files', ...(tracked ? ['--cached'] : []),
      '--others', '--exclude-standard', '-z', '--', ...snapshotPathspec(excludes)], options)).split('\0').filter(Boolean))]
  } finally {
    if (temporary) await fs.rm(temporary, { recursive: true, force: true })
  }
}

const kindOf = (stat) =>
  stat.isSymbolicLink() ? 'symlink'
    : stat.isDirectory() ? 'directory'
      : stat.isFile() ? 'file'
        : stat.isFIFO() ? 'fifo'
          : stat.isSocket() ? 'socket'
            : stat.isBlockDevice() ? 'block-device'
              : stat.isCharacterDevice() ? 'character-device' : 'unknown'

/**
 * Classify every untracked path git reports.
 *
 * @param run  (args, opts) => stdout, a git runner bound to no particular cwd
 * @returns {{entries: Array, blocking: Array, unstable: Array}}
 *          entries    fingerprint material, in git's own order
 *          blocking   paths that would stop `git add -A`; a caller must fail closed
 *          unstable   paths that moved while being read
 */
export async function classifyUntracked ({ projectPath, run, excludes = [] }) {
  const listed = await compositionPaths({ projectPath, run, excludes })
  const entries = []
  const blocking = []
  const unstable = []

  for (const name of listed) {
    const file = path.join(projectPath, name)
    let stat
    try {
      stat = await fs.lstat(file)
    } catch (error) {
      if (error.code === 'ENOENT') unstable.push({ path: name, reason: 'listed by git and gone before it could be read' })
      else blocking.push({ path: name, reason: `cannot be stat'd: ${error.code ?? error.message}`, code: error.code ?? null })
      continue
    }
    const kind = kindOf(stat)

    if (kind === 'symlink') {
      try { entries.push([name, stat.mode, sha(await fs.readlink(file))]) } catch (error) {
        if (error.code === 'ENOENT') unstable.push({ path: name, reason: 'symlink removed mid-scan' })
        else blocking.push({ path: name, reason: `symlink cannot be read: ${error.code ?? error.message}`, code: error.code ?? null })
      }
      continue
    }

    if (kind === 'directory') {
      // A nested repository: what the snapshot records is a gitlink to its HEAD.
      const head = await run(['-C', file, 'rev-parse', 'HEAD']).then((out) => out.trim()).catch(() => null)
      if (head) { entries.push([name, stat.mode, `gitlink:${head}`]); continue }
      const isRepo = await fs.stat(path.join(file, '.git')).then(() => true, () => false)
      if (isRepo) {
        // A nested repository with no commit has no gitlink target; what `git add
        // -A` records is not something to guess at.
        blocking.push({ path: name, reason: 'nested repository has no HEAD commit, so there is no gitlink for the snapshot to record', code: 'EMPTY_NESTED_REPOSITORY' })
        continue
      }
      // Not a repository. git listed the directory itself, which means it is
      // excluding what is inside it — but that is a claim worth checking rather
      // than assuming, because if git would add the contents this entry is not
      // the whole story.
      const inside = (await run(['-C', projectPath, 'ls-files', '--others', '--exclude-standard', '-z', '--', name])).split('\0').filter(Boolean)
      if (inside.length > 1 || (inside.length === 1 && inside[0] !== name)) {
        blocking.push({ path: name, reason: 'git reports this directory and also paths inside it; the snapshot cannot be predicted from the directory alone', code: 'AMBIGUOUS_DIRECTORY' })
      } else entries.push([name, stat.mode, 'directory'])
      continue
    }

    if (kind !== 'file') {
      // Never readFile a fifo: it blocks, and no timeout here would be honest.
      blocking.push({ path: name, reason: `${kind} cannot be recorded by git`, code: 'SPECIAL_FILE' })
      continue
    }

    try {
      entries.push([name, stat.mode, sha(await fs.readFile(file))])
    } catch (error) {
      if (error.code === 'ENOENT') unstable.push({ path: name, reason: 'file removed mid-scan' })
      else blocking.push({ path: name, reason: `cannot be read: ${error.code ?? error.message}`, code: error.code ?? null })
    }
  }
  return { entries, blocking, unstable }
}

/** One sentence naming what would stop the snapshot, and how many more there are. */
export function describeBlocking (blocking) {
  const [first] = blocking
  const more = blocking.length - 1
  return `the working tree cannot be snapshotted: ${first.path} ${first.reason}${more > 0 ? ` (and ${more} other path${more === 1 ? '' : 's'})` : ''}`
}
