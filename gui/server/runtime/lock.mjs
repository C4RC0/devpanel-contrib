import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { systemClock } from './clock.mjs'

/*
 * Atomic lock carrying owner identity.
 *
 * Liveness is established POSITIVELY — the pid must exist, and its boot id and
 * process start time must match what the lock recorded. Lock age is never
 * evidence: a long invocation is indistinguishable from a dead one by age alone.
 */

let cachedBootId = null

async function bootId () {
  if (cachedBootId) return cachedBootId
  try {
    cachedBootId = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
  } catch {
    cachedBootId = `no-boot-id:${os.hostname()}`
  }
  return cachedBootId
}

/** Field 22 of /proc/<pid>/stat — starttime in clock ticks since boot. */
async function processStartedAt (pid) {
  try {
    const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8')
    // The comm field may contain spaces and parentheses, so split after the last ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return fields[19] ?? null
  } catch {
    return null
  }
}

export async function currentOwner (runId = null) {
  return {
    pid: process.pid,
    bootId: await bootId(),
    processStartedAt: await processStartedAt(process.pid),
    host: os.hostname(),
    runId
  }
}

/**
 * Is the recorded owner still running? Only 'alive' permits waiting; only 'dead'
 * permits taking over. 'unknown' means we could not establish either, and the
 * caller must treat the lock as held.
 */
export async function ownerLiveness (owner) {
  if (!owner?.pid) return 'unknown'
  if (owner.bootId !== await bootId()) return 'dead'      // machine rebooted since
  if (owner.host !== os.hostname()) return 'unknown'      // another machine; cannot tell

  const startedAt = await processStartedAt(owner.pid)
  if (startedAt === null) return 'dead'                   // no such process
  if (owner.processStartedAt && startedAt !== owner.processStartedAt) return 'dead' // pid reused
  return 'alive'
}

export class LockHeld extends Error {
  constructor (file, owner, liveness) {
    super(`lock held by pid ${owner?.pid} (${liveness})`)
    this.file = file
    this.owner = owner
    this.liveness = liveness
  }
}

/**
 * Acquire an exclusive lock. Every step-creating path shares the step-allocation
 * lock: retry-on-EEXIST is not sufficient there, because two concurrent creates
 * with different slugs both succeed and both take the same number.
 */
export async function acquire (file, {
  purpose,
  runId = null,
  clock = systemClock,
  takeOverDead = true,
  // How long to queue behind a LIVE owner. Step allocation is contended by design
  // — the engine and an API request can both want a number — so callers queue
  // rather than fail. Zero means fail immediately, which is what a run lock wants.
  waitMs = 0,
  pollMs = 10
} = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const owner = await currentOwner(runId)
  const token = crypto.randomUUID()
  const record = { purpose, token, owner, acquiredAt: clock.iso(), heartbeatAt: clock.iso() }
  const deadline = Date.now() + waitMs

  const handle = {
    file,
    owner,
    token,
    /**
     * Release only what we still hold. Unlinking blindly would delete a lock a
     * different owner acquired after ours was taken over.
     */
    async release () {
      try {
        const held = JSON.parse(await fs.readFile(file, 'utf8'))
        if (held.token !== token) return false
      } catch {
        return false
      }
      await fs.rm(file, { force: true })
      return true
    }
  }

  // Losing a takeover race to another contender is worth a short re-look even
  // for a fail-fast caller: the winner either holds the lock by then or is gone.
  const contendedUntil = Date.now() + Math.max(waitMs, TAKEOVER_CONTENTION_MS)
  for (;;) {
    if (await createWith(file, record)) return handle

    const { held, liveness } = await examine(file)
    if (liveness === 'dead' && takeOverDead) {
      if (await takeOver(file, held)) continue
      if (Date.now() < contendedUntil) { await new Promise((r) => setTimeout(r, pollMs)); continue }
    } else if (Date.now() < deadline) {
      // Queue behind a live owner until the deadline, then give up.
      await new Promise((r) => setTimeout(r, pollMs))
      continue
    }
    throw new LockHeld(file, held?.owner, liveness)
  }
}

const TAKEOVER_CONTENTION_MS = 1000
/*
 * A lock file that does not parse. Locks are now published complete (link of a
 * written temp file), so this is only ever one left by the earlier open-then-
 * write, which a crash could leave empty. That window is milliseconds wide: an
 * unreadable lock older than this cannot be a write still in progress.
 */
const UNREADABLE_LOCK_DEAD_AFTER_MS = 60_000

/**
 * Publish `record` at `file` only if nothing is there, and never partially:
 * the record is written to a private temp file and hard-linked into place, so
 * a reader sees either no lock or a complete one.
 */
async function createWith (file, record) {
  const temp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temp, JSON.stringify(record, null, 2), { flag: 'wx' })
  try {
    await fs.link(temp, file)
    return true
  } catch (error) {
    if (error.code === 'EEXIST') return false
    throw error
  } finally {
    await fs.rm(temp, { force: true })
  }
}

async function examine (file) {
  let text
  try { text = await fs.readFile(file, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return { held: null, liveness: 'dead' }   // released meanwhile
    throw error
  }
  try {
    const held = JSON.parse(text)
    return { held, liveness: await ownerLiveness(held.owner) }
  } catch {
    const stat = await fs.stat(file).catch(() => null)
    const old = stat && Date.now() - stat.mtimeMs > UNREADABLE_LOCK_DEAD_AFTER_MS
    return { held: null, liveness: old ? 'dead' : 'unknown', unreadable: true }
  }
}

/**
 * Remove a dead owner's lock, serialized so two contenders cannot both observe
 * the dead owner and both unlink — which would let one delete the other's newly
 * acquired lock and leave two holders believing they own it.
 */
async function takeOver (file, held) {
  const gate = `${file}.takeover`
  const token = crypto.randomUUID()
  if (!await createWith(gate, { purpose: 'takeover', token, owner: await currentOwner(), at: new Date().toISOString() })) {
    // Another contender is taking over — unless that contender died inside the
    // gate, which would otherwise block this lock forever.
    const { held: gateHolder, liveness } = await examine(gate)
    if (liveness === 'dead') {
      const now = await fs.readFile(gate, 'utf8').catch(() => null)
      if (now !== null && (gateHolder === null || JSON.parse(now).token === gateHolder.token)) await fs.rm(gate, { force: true })
    }
    return false
  }

  try {
    // Re-read under the gate: the lock may already have been replaced.
    let current = null
    try { current = JSON.parse(await fs.readFile(file, 'utf8')) } catch {
      // Unreadable: only an old one left by the earlier writer may be removed.
      const { liveness } = await examine(file)
      if (held !== null || liveness !== 'dead') return false
      await fs.rm(file, { force: true })
      return true
    }
    if (!held || current.token !== held.token) return false          // replaced since we looked
    if (await ownerLiveness(current.owner) !== 'dead') return false  // no longer dead
    await fs.rm(file, { force: true })
    return true
  } finally {
    await fs.rm(gate, { force: true })
  }
}

/** Run `fn` while holding the lock, releasing it however `fn` ends. */
export async function withLock (file, options, fn) {
  const lock = await acquire(file, options)
  try {
    return await fn(lock)
  } finally {
    await lock.release()
  }
}
