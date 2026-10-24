import fs from 'node:fs/promises'
import path from 'node:path'

import { escapingLinks } from '../server/runtime/fingerprint.mjs'
import { authorizer, copySelected, forbiddenRootsReport, knownProjectRoots, walkSelection } from '../server/runtime/selection.mjs'

/*
 * The tooling check exports the checkout with its links kept as links, but a
 * run under `workspace.symlinks: materialize` replaces every live escaping link
 * with a directory carrying its owner's ls-files selection (launch.mjs, selection
 * v1). Without the same step a mount target behind such a link (d250's
 * @system-modules/eslint/node_modules) is refused by ensureMountPoint, and a
 * command reaching through one (@boilerplate/tooling/lint.sh) would meet a link
 * that dangles in the fence. This uses the primitives launch uses, with the
 * same authorization, consumer exclusions and tooling-mount exclusions; it does
 * not record selection or owners, since the export is thrown away after the turn.
 */
export async function materializeExport ({ worktree, checkout, workspace = {} }) {
  if (workspace.symlinks !== 'materialize') return []
  const root = await fs.realpath(checkout)
  const excludes = [...(workspace.excludes ?? []), ...(workspace.tooling?.mounts ?? []).map((m) => m.target)]
  const { roots: forbidden } = await forbiddenRootsReport()
  const authorize = authorizer({ known: await knownProjectRoots(), grants: workspace.materializeGrants ?? [], forbidden })
  const done = []
  // Links are found in the export but resolved from the checkout, so a relative
  // link means what it means there; one whose target is missing stays a link, as in a run.
  for (const l of await escapingLinks(worktree)) {
    const resolved = await fs.realpath(path.join(root, l.path)).catch(() => null)
    if (!resolved || resolved === root || resolved.startsWith(root + path.sep)) continue
    const files = []
    await walkSelection({ linkPath: l.path, resolved, consumerExcludes: excludes, authorize, onFile: (rel, full) => { files.push([rel, full]) } })
    await fs.rm(path.join(worktree, l.path), { force: true })
    if ((await fs.stat(resolved)).isDirectory()) await fs.mkdir(path.join(worktree, l.path), { recursive: true })
    for (const [rel, full] of files) await copySelected(worktree, rel, full)
    done.push(l.path)
  }
  return done
}
