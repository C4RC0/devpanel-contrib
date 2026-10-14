/*
 * How the host runs Git on a run's worktree (the seat-access fence's
 * "Repository", R9-1).
 *
 * A linked worktree finds its repository through the `.git` file at its root,
 * and that file lies inside the seat's writable working directory. A seat that
 * replaced it with a repository of its own would have the host execute that
 * repository's configuration (a filter, an fsmonitor command, a hook) the next
 * time the engine ran `git -C <worktree> …`. So the engine records the
 * worktree's git directory at provisioning, before any seat has run, and every
 * later host call names it explicitly: Git then never reads the worktree's
 * `.git` entry. The recorded directory lives in the source repository's
 * `.git/worktrees/`, which no seat can write. Hooks and fsmonitor are disabled
 * on these calls as well.
 *
 * A worktree recorded without a git directory (runs provisioned before this)
 * keeps today's `-C` discovery, so a resumed run is not changed under it.
 */

/** The empty tree, which Git resolves without the object being stored. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/*
 * No hook, no fsmonitor, no SSH helper (an external diff is unset by the
 * environment: `diff.external=` would try to run an empty command), and no attributes
 * from anywhere (`--attr-source` names the empty tree, `core.attributesFile`
 * is emptied): a work-tree `.gitattributes` a seat wrote can then neither
 * select a filter driver nor rewrite bytes on the way into the engine's
 * objects — files are stored as the fingerprint measured them (audit I11).
 */
export const HARDENED = Object.freeze(['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null',
  '-c', 'core.sshCommand=false', '-c', 'core.autocrlf=false', `--attr-source=${EMPTY_TREE}`])

/** Arguments for an operation on the worktree's files and index. */
export function worktreeGitArgs (workspacePath, gitDir = null) {
  return gitDir ? ['-C', workspacePath, ...HARDENED, '--git-dir', gitDir, '--work-tree', workspacePath] : ['-C', workspacePath, ...HARDENED]
}

/** Arguments for an operation on the repository only (refs, objects, worktree registrations). */
export function repositoryGitArgs (workspacePath, gitDir = null) {
  return gitDir ? [...HARDENED, '--git-dir', gitDir] : ['-C', workspacePath, ...HARDENED]
}

/*
 * Private repositories (0d, fence.repository: 1). Two Git directories over one
 * work tree, both under the run directory:
 *
 *   engine  trusted, written only by the engine, never mounted into a fence.
 *           A depth-1 fetch of the run's snapshot ref from the source
 *           repository: no alternates, no other refs, no history. Its HEAD is
 *           the base commit, so fingerprints, diffs, checks and reconstruction
 *           keep their identity. The recorded `workspace.gitDir`.
 *   worker  untrusted, named by the work tree's `.git` file, so `git status`,
 *           `diff`, staging and commits work inside the fence. Its objects
 *           borrow the engine's through `objects/info/alternates`, which the
 *           fence mounts read-only; the host never reads it.
 *
 * The source repository is only ever a fetch source here (and a publication
 * target, publishCandidate), always named by the run record, never found
 * through the work tree.
 */

/** An environment for engine Git: nothing inherited from GIT_*, no system or user configuration. */
export function engineGitEnv (extra = {}) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_') && k !== 'XDG_CONFIG_HOME') env[k] = v
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', ...extra }
}

/** Local transport only, for the fetch that fills the engine directory. */
export const LOCAL_TRANSPORT = Object.freeze(['-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always'])
