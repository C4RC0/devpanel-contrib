import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import * as store from './store.mjs'
import { acquire } from './lock.mjs'
import { fingerprint } from './fingerprint.mjs'
import { reconstructInto, discardReconstruction, verifyReconstruction } from './launch.mjs'
import { applyToSource, sourceTarget } from './source-delivery.mjs'

const refuse = message => Object.assign(new Error(message), { status: 409 })

export async function retainedPatch (issuePath, runId) {
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(runId)) throw refuse('Invalid run id')
  const run = await store.readRun(issuePath, runId)
  const dir = store.runDir(issuePath, runId)
  const artifacts = await fs.realpath(path.join(dir, 'artifacts'))
  if (!run.delivery?.artifactRef) throw refuse('This run has no retained patch')
  const file = await fs.realpath(path.resolve(dir, run.delivery.artifactRef))
  if (!file.startsWith(artifacts + path.sep) || !file.endsWith('.patch')) throw refuse('Invalid patch location')
  return { run, dir, file }
}

/** Explicit operator action for completed patch-only runs, including removed worktrees. */
export async function applyRunArtifact ({ issuePath, runId, projectPath, expectedRevision }) {
  if (typeof runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(runId)) throw refuse('Invalid run id')
  const lock = await acquire(path.join(issuePath, '.run.lock'), { purpose: 'apply-artifact', runId }).catch(error => { throw Object.assign(error, { status: 409 }) })
  let temporary
  try {
    await store.requireCompleteEvents(issuePath, runId)
    const { run, dir, file } = await retainedPatch(issuePath, runId)
    const delivery = run.delivery
    if (run.status !== 'completed' || run.recovery?.required || ['quarantined', 'abandoned'].includes(run.integrity?.status)) throw refuse('The run must be completed with no outstanding recovery or integrity block')
    if (!['worktree-diff', 'commit'].includes(delivery.action) || !delivery.completedAt || delivery.reconstruction?.verified !== true ||
      !expectedRevision || expectedRevision !== delivery.revision || run.closure?.revision !== expectedRevision ||
      !run.closure?.authorised || !Object.values(run.closure.conditions ?? {}).every(value => value === true)) throw refuse('Application requires the exact revision of a completed, approved delivery')
    const baseline = await store.readBaseline(issuePath, runId)
    if (!baseline || !run.workspace?.baseCommit) throw refuse('The recorded base and baseline are required; apply manually or rerun')
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-artifact-'))
    await reconstructInto({ dir: temporary, workspacePath: projectPath, baseCommit: run.workspace.baseCommit, patchFile: file })
    const workspace = { ...run.workspace, path: temporary, source: await sourceTarget(projectPath) }
    const candidate = await fingerprint(temporary, { baseline, baseCommit: workspace.baseCommit })
    if (candidate.fingerprint !== expectedRevision) throw refuse('The retained patch does not reproduce the approved revision')
    const reconstruction = await verifyReconstruction({ workspacePath: temporary, baseCommit: workspace.baseCommit, baseline, patchFile: file, expected: expectedRevision,
      expectedPaths: new Set(candidate.entries.filter(e => e.status !== 'unchanged').map(e => e.path)) })
    const patchHash = 'sha256:' + crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex')
    const receipt = await applyToSource({ workspace, baseline, revision: expectedRevision, fingerprint: candidate,
      receipt: { ...delivery, reconstruction, patchHash }, runDir: dir })
    // Preserve the historical delivery and snapshot. This is a separately
    // authorized application of that artifact, not a rewritten old run.
    run.artifactApplication = receipt.application
    await store.writeRun(issuePath, runId, run)
    await store.appendEvent(issuePath, runId, { type: 'artifact-applied', revision: expectedRevision, application: receipt.application })
    return { runId, application: receipt.application, error: receipt.application.verified ? null : receipt.application.error }
  } finally {
    if (temporary) await discardReconstruction({ dir: temporary, workspacePath: projectPath })
    await lock.release()
  }
}
