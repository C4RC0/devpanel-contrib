import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { inspectLaunchState } from './supervisor-launch-state.mjs'

const exec = promisify(execFile)

/*
 * Launch conditions that are deterministic and free to read, checked before a
 * start reserves anything or probes a model. Provisioning checks them again
 * against the tree as it is then; this only moves the refusal ahead of the
 * money. Returns null when nothing refuses, or { code, message } in the same
 * words provisioning would use.
 */
export async function launchPreconditions ({ projectPath, workspace = {}, configHash = null }) {
  if (workspace.isolation === 'in-place') return null   // the checkout is the workspace; no base is cut
  const state = await inspectLaunchState({ projectPath, workspace, configHash })
  if (state.code === 'DIRTY_BASE' || state.code === 'UNREADABLE_WORKTREE') {
    const dirty = state.code === 'DIRTY_BASE' ? Number((await exec('git', ['-C', projectPath, 'status', '--porcelain', '--untracked-files=no'], { maxBuffer: 32 << 20 })).stdout.split('\n').filter(Boolean).length) : 0
    return {
      code: state.code,
      message: state.code === 'DIRTY_BASE'
        ? `base policy "head" requires a clean checkout, but ${dirty} tracked path(s) are modified in ${projectPath}. Choose base "working-tree" to cut from the checkout as it is, name a commit, or clean the checkout. (Checked before preflight: nothing was spent.)`
        : `${state.blockedReason} (Checked before preflight: nothing was spent.)`
    }
  }
  if ((workspace.symlinks ?? 'reject') === 'reject') {
    const escaping = await escapingTrackedLinks(projectPath)
    if (escaping.length) {
      return {
        code: 'ESCAPING_SYMLINKS',
        message: `${escaping.length} symlink(s) in the checkout point outside it (${escaping.slice(0, 3).map((l) => `${l.path} -> ${l.target}`).join(', ')}${escaping.length > 3 ? ', …' : ''}). A write through such a link changes a live file the candidate does not record. Choose symlinks "materialize" to copy their targets into the worktree, or "allow" to accept that. (Checked before preflight: nothing was spent.)`
      }
    }
  }
  return null
}

/** Tracked symlinks (index mode 120000) whose target resolves outside the checkout. */
export async function escapingTrackedLinks (projectPath) {
  let listing
  try { listing = (await exec('git', ['-C', projectPath, 'ls-files', '--stage', '-z'], { maxBuffer: 64 << 20 })).stdout } catch { return [] }
  const root = path.resolve(projectPath)
  const out = []
  for (const line of listing.split('\0')) {
    if (!line.startsWith('120000 ')) continue
    const rel = line.slice(line.indexOf('\t') + 1)
    let target
    try { target = await fs.readlink(path.join(root, rel)) } catch { continue }
    const resolved = path.resolve(path.dirname(path.join(root, rel)), target)
    if (resolved !== root && !resolved.startsWith(root + path.sep)) out.push({ path: rel, target })
  }
  return out
}
