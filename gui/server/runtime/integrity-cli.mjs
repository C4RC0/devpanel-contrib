#!/usr/bin/env node
// Inspect first, then record a disposition pinned to the inspected state hash.
// This command never invokes an agent or deletes the retained workspace.
import { resumeRun, releaseOwnership } from './launch.mjs'
import { captureIntegrity, integrityChanges, readIntegrity } from './integrity.mjs'

const [issuePath, runId, ...args] = process.argv.slice(2)
const value = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
if (!issuePath || !runId) {
  console.error('usage: integrity-cli.mjs <issue-path> <run-id> [--disposition accept-partial|restored|abandon --state <hash> --actor <name> --reason <text>]')
  process.exit(2)
}
const disposition = value('--disposition')
let engine
try {
  engine = await resumeRun({ issuePath, runId, harnesses: {}, takeLock: Boolean(disposition) })
  if (disposition) {
    await engine.resolveIntegrity({ disposition, expectedStateHash: value('--state'), actor: value('--actor'), reason: value('--reason') })
    console.log(JSON.stringify({ integrity: engine.run.integrity, status: engine.run.status }, null, 2))
  } else {
    const report = engine.run.integrity?.latest
    const before = report?.before ? await readIntegrity(engine.integrityDir(), report.before) : null
    const current = await captureIntegrity(engine.run.workspace, { clock: engine.clock, trackedPaths: before?.trackedPaths })
    console.log(JSON.stringify({ workspace: engine.run.workspace.path, integrity: engine.run.integrity, stateHash: current.hash, changes: before ? integrityChanges(before, current) : null }, null, 2))
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  if (disposition && engine) await releaseOwnership(engine, { reason: 'integrity recovery disposition recorded; workspace retained' })
}
