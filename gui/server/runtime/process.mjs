import { spawn } from 'node:child_process'
import crypto from 'node:crypto'

import { systemClock } from './clock.mjs'
import { hostPlatform, REAP_TAG } from './platform.mjs'

/*
 * Subprocess execution with confirmed termination.
 *
 * Cancelling an agent turn means stopping the WORK, not stopping the wait.
 * Resolving early leaves a live process writing to a workspace the engine is
 * about to hand away, so nothing here reports a cancellation until the process
 * and its descendants are provably gone.
 *
 * Children are spawned detached, which makes each invocation its own process
 * group. Signalling the group reaches tool processes the agent runtime spawned;
 * signalling only the parent orphans them.
 */

const DEFAULT_GRACE_MS = 5000

/** Is this process (or group, for a negative pid) still present? */
export function alive (pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists but belongs to someone else — still alive.
    return error.code === 'EPERM'
  }
}

async function waitUntilGone (pid, { deadlineMs, pollMs = 20 }) {
  const until = Date.now() + deadlineMs
  while (Date.now() < until) {
    if (!alive(pid)) return true
    await new Promise((r) => setTimeout(r, pollMs))
  }
  return !alive(pid)
}

/**
 * Terminate a process group and confirm it is gone.
 *
 * SIGTERM first, so a well-behaved runtime can clean up; SIGKILL after the grace
 * period, because a child that ignores SIGTERM must not be able to outlive its
 * cancellation. Returns only once nothing in the group answers.
 */
export async function terminateGroup (pgid, { graceMs = DEFAULT_GRACE_MS, clock = systemClock } = {}) {
  const target = -Math.abs(pgid)
  const result = { requestedAt: clock.now(), escalated: false, confirmedAt: null, method: null }

  try {
    process.kill(target, 'SIGTERM')
    result.method = 'SIGTERM'
  } catch (error) {
    if (error.code === 'ESRCH') {
      result.confirmedAt = clock.now()
      result.method = 'already-gone'
      return result
    }
    throw error
  }

  if (await waitUntilGone(target, { deadlineMs: graceMs })) {
    result.confirmedAt = clock.now()
    return result
  }

  // Ignoring SIGTERM buys a grace period, not survival.
  result.escalated = true
  result.method = 'SIGKILL'
  try { process.kill(target, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }

  // No deadline on this wait: SIGKILL is not refusable, and returning while the
  // group might still exist would defeat the entire purpose.
  while (alive(target)) await new Promise((r) => setTimeout(r, 20))

  result.confirmedAt = clock.now()
  return result
}

/*
 * Processes a reaped command left behind outside its process group.
 *
 * A descendant that called setsid() has left the group, so signalling the group
 * cannot reach it — but it inherited the environment, and every reaped command
 * carries a unique DEVPANEL_REAP_TAG. The host's platform module finds the
 * processes still carrying it, and says whether it could look at all.
 * (Matching stdio instead does not work: Node's pipes are socketpairs, and the
 * two ends have different inodes.)
 *
 * The record keeps "found nothing" apart from "could not tell": `complete` is
 * the only status that proves the tag is gone. A host whose scan mechanism is
 * not proved (darwin's `ps -E`) keeps the parser's verdict as the status and
 * says so with `mechanism: 'unproved'`: a scan that parsed complete counts as
 * complete; one that did not is also `reason: 'structural'`, because no rescan
 * on this host can prove it (cleanup-barrier.mjs).
 */
function scanRecord (platform, found, tag) {
  const record = { method: found.method, tag, escaped: found.pids.length,
    ...(found.notInspected?.length ? { notInspected: found.notInspected } : {}) }
  if (!platform.descendantScan?.proved) {
    const unproved = { status: found.status, mechanism: 'unproved', ...record, detail: platform.descendantScan?.reason ?? null }
    return found.status === 'complete' ? unproved : { ...unproved, reason: 'structural', ...(found.reason ? { parsedReason: found.reason } : {}) }
  }
  return { status: found.status, ...record, ...(found.reason ? { reason: found.reason } : {}) }
}

export async function terminatePids (pids, { graceMs = DEFAULT_GRACE_MS, clock = systemClock } = {}) {
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
  const until = clock.now() + graceMs
  while (pids.some(alive) && clock.now() < until) await new Promise((r) => setTimeout(r, 20))
  for (const pid of pids.filter(alive)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  while (pids.some(alive)) await new Promise((r) => setTimeout(r, 20))
}

const DEFAULT_CLOSE_GRACE_MS = 2000

export class ProcessError extends Error {
  constructor (message, detail = {}) {
    super(message)
    this.name = 'ProcessError'
    Object.assign(this, detail)
  }
}

/**
 * Run a command to completion, or terminate it on abort and confirm termination
 * before returning.
 *
 * Resolves with `{ cancelled: true, termination }` rather than throwing on abort,
 * so the caller can tell "the work stopped" from "the command failed".
 */
export async function runProcess ({
  command,
  args = [],
  cwd,
  env = process.env,
  stdin = null,
  signal = null,
  graceMs = DEFAULT_GRACE_MS,
  maxBuffer = 64 * 1024 * 1024,
  clock = systemClock,
  /**
   * Reap what the command leaves behind: once it exits (or is cancelled), stop
   * the rest of its process group and any escaped descendant still holding its
   * environment tag. For agent turns and checks, whose workspace is handed on the
   * moment they return. Off for operator scripts, which may start a daemon on
   * purpose.
   */
  reap = false,
  // The tag to reap by; a caller that records it before the spawn (the engine,
  // so a crashed owner's descendants can still be found) passes its own.
  reapTag = null,
  // The host OS probes (platform.mjs); injectable so tests can read a fake listing.
  platform = hostPlatform(),
  closeGraceMs = DEFAULT_CLOSE_GRACE_MS,
  /**
   * Observation hooks, for telemetry while the process runs:
   *   onSpawn({ pid, command, args, cwd })   the process exists
   *   onOutput(stream, chunk)     a chunk arrived on 'stdout' or 'stderr'
   * Errors thrown by a hook are swallowed: watching a process must not be able
   * to fail the process.
   */
  observe = null
} = {}) {
  const tag = reap ? (reapTag ?? crypto.randomUUID()) : null
  const child = spawn(command, args, {
    cwd,
    env: tag ? { ...env, [REAP_TAG]: tag } : env,
    detached: true,                     // its own process group
    stdio: ['pipe', 'pipe', 'pipe']
  })

  const started = clock.now()
  let truncated = false

  const watch = (fn, ...args) => { try { fn?.(...args) } catch { /* observers cannot fail the run */ } }

  /*
   * The retained buffer is the TAIL of the stream, not the head. A runtime's
   * final record is its last line, and a verbose turn that keeps only its first
   * 64 MiB has thrown away the one line the caller needs. Every byte is still
   * handed to the observer as it arrives; only what is kept in memory is capped,
   * and `truncated` is set whenever anything was dropped.
   */
  const tail = () => {
    const chunks = []
    let size = 0
    return {
      push (chunk) {
        chunks.push(chunk)
        size += chunk.length
        while (size > maxBuffer && chunks.length) {
          const first = chunks[0]
          const excess = size - maxBuffer
          truncated = true
          if (first.length <= excess) { chunks.shift(); size -= first.length } else { chunks[0] = first.slice(excess); size -= excess }
        }
      },
      text: () => chunks.join('')
    }
  }
  const out = tail()
  const err = tail()

  const collect = (name, stream, keep) => {
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => {
      // Observers first: they see every byte, whatever the buffer keeps.
      watch(observe?.onOutput, name, chunk)
      keep.push(chunk)
    })
  }
  collect('stdout', child.stdout, out)
  collect('stderr', child.stderr, err)

  // A Buffer is written as bytes; a string as UTF-8; a readable stream is piped
  // (large inputs are never held in memory). Never re-encode a Buffer.
  if (stdin !== null && typeof stdin?.pipe === 'function') {
    stdin.on('error', () => child.stdin.destroy())
    stdin.pipe(child.stdin)
  } else if (stdin !== null) child.stdin.end(stdin)
  else child.stdin.end()
  child.stdin.on('error', () => {})   // a child that exits before reading stdin is reported by its exit, not by EPIPE

  const spawned = new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })

  try {
    await spawned
  } catch (error) {
    throw new ProcessError(`could not start "${command}": ${error.message}`, { kind: 'spawn-error', started: false, code: error.code, command })
  }

  const pid = child.pid
  watch(observe?.onSpawn, { pid, command, args, cwd })
  let termination = null

  // `exit` is the child itself; `close` additionally waits for every holder of
  // its stdio to let go, which a descendant outside the group may never do.
  const exited = new Promise((resolve) => {
    child.once('exit', (code, sig) => resolve({ code, signal: sig }))
  })
  let closed = false
  const whenClosed = new Promise((resolve) => child.once('close', () => { closed = true; resolve() }))
  const closeWithin = (ms) => Promise.race([whenClosed, new Promise((r) => setTimeout(r, ms).unref())])

  let abortHandler = null
  const onAbort = () => { abortHandler = terminateGroup(pid, { graceMs, clock }).then((t) => { termination = t }) }

  // Removed in `finally`. A listener left on a shared signal outlives its process
  // and would try to terminate a pgid that has since been recycled by the OS —
  // signalling somebody else's process group entirely.
  let listening = false
  if (signal) {
    if (signal.aborted) onAbort()
    else { signal.addEventListener('abort', onAbort); listening = true }
  }

  let outcome
  const leftovers = { group: null, escaped: [], streamsAbandoned: false, scan: { status: 'not-requested' } }
  try {
    outcome = await exited
    // Termination is awaited AFTER the process exited, so this returns only once
    // the group has been confirmed gone.
    if (abortHandler) await abortHandler
    else if (reap && alive(-pid)) leftovers.group = await terminateGroup(pid, { graceMs, clock })
    if (reap) {
      // Escaped descendants are reaped whether or not they hold our output: one
      // that redirected its stdio still writes into a workspace being handed on.
      const found = await platform.taggedProcesses(tag)
      leftovers.escaped = found.pids
      if (leftovers.escaped.length) await terminatePids(leftovers.escaped, { graceMs, clock })
      leftovers.scan = scanRecord(platform, found, tag)
    }
    // Termination of the group is confirmed above; of escaped descendants only
    // a complete scan can say it.
    if (termination) Object.assign(termination, { descendants: leftovers.scan.status, complete: reap && leftovers.scan.status === 'complete' })
    await closeWithin(closeGraceMs)
    if (!closed) {
      // Output already read is kept; a holder we may not stop cannot keep the
      // caller waiting forever.
      leftovers.streamsAbandoned = true
      child.stdout.destroy()
      child.stderr.destroy()
    }
  } finally {
    if (listening) signal.removeEventListener('abort', onAbort)
  }

  return {
    pid,
    command,
    args,
    code: outcome.code,
    signal: outcome.signal,
    stdout: out.text(),
    stderr: err.text(),
    truncated,
    durationMs: clock.now() - started,
    cancelled: Boolean(termination),
    termination,
    leftovers
  }
}
