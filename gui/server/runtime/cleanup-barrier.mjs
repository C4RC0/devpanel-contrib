import fs from 'node:fs/promises'
import path from 'node:path'

import { withLock } from './lock.mjs'

/*
 * Escaped descendants whose cleanup was not proved, and the barrier they put
 * on a shared in-place checkout.
 *
 * A turn's reap scan (process.mjs) that is not `complete` leaves a cleanup
 * entry on the run: `{ role, stepId, invocationId, tag, reason, scan, at }`,
 * open until it is proved (a later scan of its tag is complete and finds
 * nothing) or acknowledged by a person (who, when, why). While any entry is
 * open the run hands its workspace to no writer.
 *
 * An in-place run's workspace is the project checkout, which every issue of
 * the project shares, so its open entries are also kept in
 * issues/<project>/.cleanup-barrier.json, outside any issue or run: no new or
 * resumed in-place writer of the project starts while one is there, and
 * abandoning, deleting or archiving the run does not lift it. Every lift is
 * appended to the file's history.
 */

export const STRUCTURAL = 'the descendant scan cannot prove this cleanup on this host (darwin: the ps -E inspection is not yet proved on a Mac, so a rescan proves nothing); only an operator acknowledgement can lift this'

/** Entries neither proved nor acknowledged. */
export const openCleanup = (run) => (run?.cleanup?.entries ?? []).filter((e) => !e.provedAt && !e.acknowledgedAt)

/** Was this scan short of proof? A missing scan (nothing was reaped) is not. */
export const unprovedScan = (scan) => Boolean(scan && scan.status !== 'complete' && scan.status !== 'not-requested')

export function cleanupReason (scan) {
  if (scan.reason === 'structural') return 'scan-structural'
  return scan.status === 'incomplete' ? 'scan-incomplete' : 'scan-unavailable'
}

/** Can no rescan on this host settle it? Then only an acknowledgement can. */
const structuralScan = (scan) => scan.reason === 'structural' || scan.mechanism === 'unproved'

/** A cleanup entry for one turn whose scan was not proved. */
export function cleanupEntry ({ role, stepId, invocationId, scan, reason = cleanupReason(scan), at }) {
  return { role, stepId, invocationId, tag: scan.tag ?? null, reason, structural: structuralScan(scan), scan, at }
}

/*
 * A turn left in flight by an owner that disappeared: its tag (persisted on the
 * pending invocation before launch) is scanned at once, scan only. A complete
 * scan that finds nothing is proved on the spot (on a host whose mechanism is
 * unproved, as `mechanism: 'unproved'`, like a turn's own scan); a survivor or
 * a scan short of complete stays open, and so does one that threw. Nothing is
 * terminated here: killing at recovery would be reaping Linux never did.
 */
export async function lostTagEntry (platform, { role, stepId, invocationId, tag, at }) {
  const listed = await platform.taggedProcesses(tag).catch((error) => ({ status: 'unavailable', method: null, pids: [], reason: error.message }))
  const found = { ...listed, tag }
  const scan = platform.descendantScan?.proved
    ? found
    : { ...found, mechanism: 'unproved', detail: platform.descendantScan?.reason ?? null, ...(found.status === 'complete' ? {} : { reason: 'structural', ...(found.reason ? { parsedReason: found.reason } : {}) }) }
  const entry = { role, stepId, invocationId, tag, reason: 'owner-lost', structural: structuralScan(scan), scan, at }
  if (scan.status === 'complete' && !scan.pids?.length) entry.provedAt = at
  return entry
}

/**
 * Turn the reap tags a lost owner's pending invocations left on disk into
 * cleanup entries (once each). Open ones of an in-place run bar the checkout.
 */
export async function noteLostTags (run, { platform, projectDir, at }) {
  const known = new Set((run.cleanup?.entries ?? []).map((e) => e.tag))
  for (const [role, p] of Object.entries(run.participants ?? {})) {
    const pending = p?.pendingInvocation
    if (!pending?.reapTag || known.has(pending.reapTag)) continue
    const entry = await lostTagEntry(platform, { role, stepId: pending.cursor?.stepId ?? null, invocationId: pending.invocationId, tag: pending.reapTag, at })
    run.cleanup ??= { entries: [] }
    run.cleanup.entries.push(entry)
  }
  // Every entry, not only the new ones: a tag the barrier holds from before the
  // crash (written ahead of the run record) and proved now is lifted, and an
  // earlier barrier write that failed after its entry was recorded is made good.
  await syncBarrier(projectDir, run, { at, by: 'owner-lost-detection' })
}

/*
 * Prove open entries: scan each tag again. An entry whose own turn should have
 * reaped (scan-*) has its survivors terminated and is scanned once more; an
 * owner-lost entry is scanned only, and a survivor is named, never killed.
 * Proved entries get `provedAt`; every attempt is kept on the entry.
 * `terminate` is process.mjs terminatePids, passed in: this module is read by
 * run explanations, which must not load the process runner.
 */
export async function proveEntries (entries, { platform, at, terminate }) {
  if (entries.some((e) => e.structural) || !platform.descendantScan?.proved) {
    throw Object.assign(new Error(`Cleanup cannot be proved: ${STRUCTURAL}.`), { status: 409, code: 'SCAN_UNAVAILABLE' })
  }
  for (const entry of entries) {
    let scan = await platform.taggedProcesses(entry.tag)
    let terminated = []
    if (scan.status === 'complete' && scan.pids.length && entry.reason !== 'owner-lost') {
      await terminate(scan.pids, {})
      terminated = scan.pids
      scan = await platform.taggedProcesses(entry.tag)
    }
    entry.attempts = [...(entry.attempts ?? []), { at, status: scan.status, survivors: scan.pids ?? [], terminated, ...(scan.reason ? { reason: scan.reason } : {}) }]
    if (scan.status === 'complete' && !scan.pids.length) entry.provedAt = at
  }
  return entries.filter((e) => !e.provedAt)
}

export function cleanupRefusal (open) {
  const survivors = open.flatMap((e) => e.attempts?.at(-1)?.survivors ?? [])
  return Object.assign(new Error(`Cleanup is not proved for ${open.map((e) => `${e.role} (tag ${e.tag})`).join(', ')}${survivors.length ? `: process(es) ${survivors.join(', ')} still carry the tag` : ''}. Stop them, or acknowledge the cleanup with a reason.`), { status: 409, code: 'CLEANUP_UNPROVED' })
}

// --- the project barrier -------------------------------------------------------

const barrierFile = (projectDir) => path.join(projectDir, '.cleanup-barrier.json')

export async function readBarrier (projectDir) {
  try {
    const data = JSON.parse(await fs.readFile(barrierFile(projectDir), 'utf8'))
    return { version: 1, entries: data.entries ?? [], history: data.history ?? [] }
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, entries: [], history: [] }
    throw error
  }
}

async function updateBarrier (projectDir, change) {
  return withLock(path.join(projectDir, '.cleanup-barrier.lock'), { purpose: 'cleanup-barrier', waitMs: 10000 }, async () => {
    const barrier = await readBarrier(projectDir)
    const before = JSON.stringify(barrier)
    const result = change(barrier)
    const file = barrierFile(projectDir)
    if (JSON.stringify(barrier) === before) return result
    if (!barrier.entries.length && !barrier.history.length) {
      await fs.rm(file, { force: true })
    } else {
      await fs.writeFile(`${file}.tmp`, JSON.stringify(barrier, null, 2))
      await fs.rename(`${file}.tmp`, file)
    }
    return result
  })
}

/** Bar the project's in-place checkout for these open entries of one run. */
export const addBarrierEntries = (projectDir, { issueId, runId, checkout }, entries) => updateBarrier(projectDir, (b) => {
  for (const e of entries) {
    if (b.entries.some((x) => x.runId === runId && x.tag === e.tag)) continue
    b.entries.push({ issueId, runId, checkout, tag: e.tag, role: e.role, invocationId: e.invocationId, reason: e.reason, structural: e.structural, at: e.at })
  }
})

/** Lift a run's entries (all, or those `tags`), recording who lifted them and how. */
export const liftBarrierEntries = (projectDir, { issueId, runId, tags = null, type, by, at, reason = null }) => updateBarrier(projectDir, (b) => lift(b, { issueId, runId, tags, type, by, at, reason }))

function lift (b, { issueId, runId, tags = null, type, by, at, reason = null }) {
  const lifted = b.entries.filter((e) => e.runId === runId && (!tags || tags.includes(e.tag)))
  if (!lifted.length) return []
  b.entries = b.entries.filter((e) => !lifted.includes(e))
  b.history.push({ type, issueId, runId, tags: lifted.map((e) => e.tag), by, at, ...(reason ? { reason } : {}) })
  return lifted
}

/**
 * Make the barrier say what an in-place run's record says, in one write: its
 * open entries are on it, and those it proved or acknowledged are not, so a
 * run with nothing open never keeps another issue barred.
 */
export function syncBarrier (projectDir, run, { at, by }) {
  if (run?.workspace?.isolation !== 'in-place' || !run.cleanup?.entries?.length) return
  const ref = { issueId: run.issue?.id ?? null, runId: run.runId }
  const entries = run.cleanup.entries
  return updateBarrier(projectDir, (b) => {
    for (const e of openCleanup(run)) {
      if (!b.entries.some((x) => x.runId === ref.runId && x.tag === e.tag)) b.entries.push({ ...ref, checkout: run.workspace.path, tag: e.tag, role: e.role, invocationId: e.invocationId, reason: e.reason, structural: e.structural, at: e.at })
    }
    const proved = entries.filter((e) => e.provedAt).map((e) => e.tag)
    if (proved.length) lift(b, { ...ref, tags: proved, type: 'proved', by, at })
    for (const e of entries.filter((x) => !x.provedAt && x.acknowledgedAt)) {
      lift(b, { ...ref, tags: [e.tag], type: 'acknowledged', by: e.acknowledgement?.by ?? by, at, reason: e.acknowledgement?.reason ?? null })
    }
  })
}

/**
 * Open entries of an in-place run that the barrier file does not hold (all of
 * them when the file cannot be read). While there are any, the run record is
 * their only durable copy: deleting, archiving or packing it would drop them.
 */
export async function unrecordedCleanup (projectDir, run) {
  const open = run?.workspace?.isolation === 'in-place' ? openCleanup(run) : []
  if (!open.length) return []
  const barrier = await readBarrier(projectDir).catch(() => null)
  return barrier ? open.filter((e) => !barrier.entries.some((b) => b.runId === run.runId && b.tag === e.tag)) : open
}

export const unrecordedRefusal = (run, verb) => `Run ${run.runId} left processes on the project checkout that were not proved gone, and the project's cleanup barrier does not record them: ${verb} would drop the only record. Prove or acknowledge its cleanup first.`

/**
 * The refusal for an in-place writer while the barrier holds entries of other
 * runs; null when free. `unrecorded` are open entries the barrier file could
 * not be written with (each carrying the write's error): they bar the same.
 */
export function barrierRefusal (barrier, { exceptRunId = null, unrecorded = [] } = {}) {
  const extra = unrecorded.filter((u) => !barrier.entries.some((e) => e.runId === u.runId && e.tag === u.tag))
  const held = [...barrier.entries, ...extra].filter((e) => e.runId !== exceptRunId)
  if (!held.length) return null
  const structural = held.some((e) => e.structural)
  const failed = held.find((e) => e.unrecorded)
  return Object.assign(new Error(`The project's checkout is barred: escaped descendants of ${held.map((e) => `${e.issueId}/${e.runId} (tag ${e.tag})`).join(', ')} were not proved gone. ${structural ? `${STRUCTURAL[0].toUpperCase()}${STRUCTURAL.slice(1)}.` : 'Prove the cleanup or acknowledge it on that run.'}${failed ? ` The barrier file could not be written (${failed.unrecorded}); this server holds the barrier until it can be.` : ''}`), { status: 409, code: 'CLEANUP_BARRIER', barrier: held })
}
