import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'

/*
 * Host OS probes, in one place.
 *
 * Boot and process identity (lock liveness), tagged-process inspection
 * (reaping), mount discovery (selection) and what the host can confine are
 * read here and nowhere else in gui/server. Linux is the code that lived at
 * the call sites, moved verbatim; darwin answers the same questions with
 * sysctl and ps. A probe that cannot answer says so — 'unknown',
 * 'unavailable', 'not-applicable' — and never answers 'absent' or 'none' for
 * a question it could not ask.
 *
 * Every primitive (exec, readFile, readdir, kill, uid) is injectable, so both
 * implementations are exercised on any host: `platformFor('darwin', { exec })`
 * reads a fake listing without touching process.platform. This module must
 * not import process.mjs: runProcess itself asks it for tagged processes.
 */

/** The environment variable every reaped command carries (process.mjs). */
export const REAP_TAG = 'DEVPANEL_REAP_TAG'

const DARWIN_SCAN_UNPROVED = 'the darwin reap inspection (ps -E) is not yet proved on a Mac'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// Stable output whatever the operator's locale and zone: lstart is printed in
// the C locale and in UTC, so two readings of one process compare equal.
const C_ENV = { LC_ALL: 'C', TZ: 'UTC', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }

/** execFile as a value: `{ ok, code, stdout, stderr, error }`, never a throw. */
function execDefault (command, args, { env = C_ENV, timeoutMs = 10000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { env, timeout: timeoutMs, maxBuffer, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ ok: !error, code: typeof error?.code === 'number' ? error.code : error ? null : 0, stdout: stdout ?? '', stderr: stderr ?? '', error: error ? error.message : null })
    })
  })
}

function linux ({ id = 'linux', readFile = fs.readFile, readdir = fs.readdir, hostname = os.hostname } = {}) {
  let cachedBootId = null
  return {
    id,
    descendantScan: { proved: true },
    runtimeTempPrefix: id === 'linux' ? '/tmp/dpc-' : null,
    geminiSystemConfigDir: id === 'win32' ? 'C:\\ProgramData\\gemini-cli' : '/etc/gemini-cli',
    bubblewrap: id === 'linux',

    async bootId () {
      if (cachedBootId) return cachedBootId
      try {
        cachedBootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
      } catch {
        cachedBootId = `no-boot-id:${hostname()}`
      }
      return cachedBootId
    },

    /** Field 22 of /proc/<pid>/stat — starttime in clock ticks since boot. */
    async processStart (pid) {
      try {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
        // The comm field may contain spaces and parentheses, so split after the last ')'.
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        const startedAt = fields[19] ?? null
        return startedAt === null ? { state: 'absent' } : { state: 'present', startedAt }
      } catch {
        return { state: 'absent' }
      }
    },

    /*
     * /proc/<pid>/environ is readable for our own processes; elsewhere, and for
     * anything we may not inspect, nothing is reported ("gone, or not ours").
     * Only a /proc that cannot be listed at all leaves the scan unavailable.
     */
    async taggedProcesses (tag, { self = process.pid } = {}) {
      const needle = Buffer.from(`${REAP_TAG}=${tag}\0`)
      let entries
      try { entries = await readdir('/proc') } catch (error) {
        return { status: 'unavailable', method: 'proc-environ', pids: [], reason: `/proc cannot be listed (${error.code ?? error.message})` }
      }
      const pids = []
      for (const entry of entries) {
        const pid = Number(entry)
        if (!Number.isInteger(pid) || pid === self) continue
        try { if ((await readFile(`/proc/${pid}/environ`)).includes(needle)) pids.push(pid) } catch { /* gone, or not ours */ }
      }
      return { status: 'complete', method: 'proc-environ', pids }
    },

    async mountTable () {
      const source = '/proc/self/mountinfo'
      try { return { status: 'read', source, text: await readFile(source, 'utf8') } } catch (error) {
        return { status: 'unreadable', source, text: '', reason: error.code ?? error.message }
      }
    },

    describe () {
      return { platform: id, startTimePrecision: 'clock-tick', descendantScan: 'proved', unavailable: [], notApplicable: [] }
    }
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const LSTART = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) {1,2}(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/

/** `ps -o lstart` in the C locale and UTC, as epoch seconds; null for anything else. */
export function parseLstart (text) {
  const m = LSTART.exec(text.trim())
  if (!m) return null
  const [, mon, day, hh, mm, ss, year] = m
  const parts = [Number(year), MONTHS.indexOf(mon), Number(day), Number(hh), Number(mm), Number(ss)]
  const ms = Date.UTC(...parts)
  const d = new Date(ms)
  // Every component must read back unchanged: 31 Feb, 25:00 or 07:42:99 is
  // not rolled over into another instant, it is not a start time at all.
  const back = [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
  if (back.some((v, i) => v !== parts[i])) return null
  return ms / 1000
}

/*
 * darwin. Process start time comes from `ps -o lstart`, which has whole-second
 * precision. That is accepted as a pid-reuse guard on one argument: XNU hands
 * pids out sequentially and wraps at PID_MAX (99999), so the same pid can be
 * given to a new process within the same second only after the whole range
 * was cycled in that second. It is recorded (`startTimePrecision: 'second'`)
 * and remains unproved until a Mac runs `node test/run.mjs lock`.
 *
 * The reap inspection reads `ps -E`, which appends each process's initial
 * environment. Rows ps could not inspect — it prints the bare name in
 * parentheses when KERN_PROCARGS2 fails — make the scan incomplete when they
 * are this user's and not zombies. Until a Mac proves that format the scan is
 * `descendantScan.proved: false`: a scan that parses complete (every row of
 * this user inspected, our own pid present, no malformed row) is accepted as
 * complete with `mechanism: 'unproved'`; anything short of that cannot be
 * proved by a rescan here, only acknowledged (process.mjs, cleanup-barrier.mjs).
 */
function darwin ({ exec = execDefault, kill = (pid, signal) => process.kill(pid, signal), uid = () => process.getuid(), hostname = os.hostname } = {}) {
  let cachedBootId = null
  const exists = (pid) => {
    try { kill(pid, 0); return true } catch (error) {
      if (error.code === 'ESRCH') return false
      return error.code === 'EPERM' ? true : null
    }
  }
  return {
    id: 'darwin',
    descendantScan: { proved: false, reason: DARWIN_SCAN_UNPROVED },
    runtimeTempPrefix: null,
    geminiSystemConfigDir: '/Library/Application Support/GeminiCli',
    bubblewrap: false,

    /** A per-boot uuid; null when it cannot be read, never a stand-in. */
    async bootId () {
      if (cachedBootId) return cachedBootId
      const out = await exec('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], { env: C_ENV })
      const value = out.ok ? out.stdout.trim() : ''
      if (!UUID.test(value)) return null
      cachedBootId = `darwin-boot:${value.toLowerCase()}`
      return cachedBootId
    },

    async processStart (pid) {
      const before = exists(pid)
      if (before === false) return { state: 'absent' }
      if (before === null) return { state: 'unknown', reason: 'the process could not be signalled' }
      const out = await exec('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { env: C_ENV })
      const text = out.stdout.trim()
      if (out.ok && text) {
        const at = parseLstart(text)
        return at === null ? { state: 'unknown', reason: `unreadable start time: ${text.slice(0, 80)}` } : { state: 'present', startedAt: `lstart:${at}` }
      }
      // Gone between the two looks is absence; anything else is not knowing.
      if (!text && exists(pid) === false) return { state: 'absent' }
      return { state: 'unknown', reason: out.error ?? `ps printed nothing (exit ${out.code})` }
    },

    async taggedProcesses (tag, { self = process.pid } = {}) {
      const out = await exec('/bin/ps', ['-E', '-ww', '-A', '-o', 'pid=,uid=,stat=,command='], { env: C_ENV })
      if (!out.ok) return { status: 'unavailable', method: 'ps-E', pids: [], reason: out.error ?? `ps exited ${out.code}` }
      const me = uid()
      const token = `${REAP_TAG}=${tag}`
      const pids = []
      const notInspected = []
      let malformed = 0
      let sawSelf = false
      for (const line of out.stdout.split('\n')) {
        if (!line.trim()) continue
        const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s?(.*)$/.exec(line)
        if (!m) { malformed++; continue }
        const pid = Number(m[1])
        if (pid === self) { sawSelf = true; continue }
        if (Number(m[2]) !== me || m[3].startsWith('Z')) continue
        const command = m[4].trim()
        // No command and environment at all, or only the bare name ps prints
        // when it could not read them: this process was not inspected.
        if (!command || /^\(.*\)$/.test(command)) { notInspected.push(pid); continue }
        if (command.split(/\s+/).includes(token)) pids.push(pid)
      }
      const problems = []
      if (!sawSelf) problems.push('the listing does not include this process')
      if (malformed) problems.push(`${malformed} unreadable row(s)`)
      if (notInspected.length) problems.push(`${notInspected.length} process(es) of this user could not be inspected`)
      return problems.length
        ? { status: 'incomplete', method: 'ps-E', pids, notInspected, reason: problems.join('; ') }
        : { status: 'complete', method: 'ps-E', pids }
    },

    async mountTable () {
      return { status: 'not-applicable', source: null, text: '', reason: 'macOS has no idmapped container mounts to discover; the home, panel and prefix roots still apply' }
    },

    describe () {
      return {
        platform: 'darwin',
        startTimePrecision: 'second',
        descendantScan: 'unproved',
        unavailable: ['seatFence', 'offlineWrapper', 'geminiReadOnlyRoots', 'projectSandboxProbe', 'descendantScanProof'],
        notApplicable: ['mountDiscovery']
      }
    }
  }
}

/** The implementation for `id`, with any primitive replaced (tests). */
export function platformFor (id, primitives = {}) {
  return id === 'darwin' ? darwin(primitives) : linux({ ...primitives, id })
}

let host = null
/** This host's implementation, chosen once from process.platform (never written). */
export const hostPlatform = () => (host ??= platformFor(process.platform))
