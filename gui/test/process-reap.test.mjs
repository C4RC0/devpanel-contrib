import { execFile, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { runProcess, alive } from '../server/runtime/process.mjs'
import { unprovedScan } from '../server/runtime/cleanup-barrier.mjs'
import { hostPlatform, platformFor, REAP_TAG } from '../server/runtime/platform.mjs'

// A zombie still answers kill(0); it is not running. Read from /proc on Linux, from ps elsewhere.
const zombie = (pid) => process.platform === 'linux'
  ? fs.readFile(`/proc/${pid}/stat`, 'utf8').then((s) => s.slice(s.lastIndexOf(')') + 2).startsWith('Z'), () => true)
  : new Promise((resolve) => execFile('ps', ['-o', 'stat=', '-p', String(pid)], (error, out) => resolve(error ? true : out.trim().startsWith('Z'))))
const running = async (pid) => alive(pid) && !(await zombie(pid))
const hasSetsid = () => new Promise((resolve) => execFile('sh', ['-c', 'command -v setsid'], (error) => resolve(!error)))
// A child that changes session portably: node's detached spawn calls setsid().
const node = `'${process.execPath}'`
const detached = (stdio) => `${node} -e "require('child_process').spawn('sleep',['30'],{detached:true,stdio:'${stdio}'}).unref()"`

export default async function (t) {
  const setsid = await hasSetsid()

  t.section('cancelling a reaped command does not wait on a descendant that left the process group')
  if (!setsid) t.skip('a setsid(1) descendant', 'no setsid binary on this host; the portable section below covers it')
  else {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 300)
    const started = Date.now()
    const result = await runProcess({ command: 'sh', args: ['-c', 'setsid sleep 30 & echo started; sleep 30'], signal: controller.signal, reap: true, graceMs: 500 })
    t.ok('returns promptly instead of waiting for the pipe to close', Date.now() - started < 5000, `${Date.now() - started} ms`)
    t.ok('reports the cancellation', result.cancelled)
    t.eq('finds the escaped descendant', result.leftovers.escaped.length, 1)
    t.eq('and it is gone', await running(result.leftovers.escaped[0]), false)
    t.eq('output read before the cancel is kept', result.stdout, 'started\n')
  }

  t.section('the same with a child that changes session through node (any POSIX host)')
  {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 1500)
    const started = Date.now()
    const result = await runProcess({ command: 'sh', args: ['-c', `${detached('ignore')}; echo started; sleep 30`], signal: controller.signal, reap: true, graceMs: 500 })
    t.ok('returns promptly', Date.now() - started < 8000, `${Date.now() - started} ms`)
    t.ok('reports the cancellation', result.cancelled)
    t.eq('finds the escaped descendant', result.leftovers.escaped.length, 1)
    t.eq('and it is gone', await running(result.leftovers.escaped[0]), false)
    const proved = hostPlatform().descendantScan.proved
    t.eq('the scan is complete; its mechanism is named unproved where it is (darwin, OP-2)', [result.leftovers.scan.status, result.leftovers.scan.mechanism ?? null], ['complete', proved ? null : 'unproved'])
    t.eq('termination is complete once the scan is', result.termination.complete, true)
  }

  t.section('a reaped command that exits normally leaves nothing running in its group')
  {
    const result = await runProcess({ command: 'sh', args: ['-c', '(sleep 30) </dev/null >/dev/null 2>&1 & echo done'], reap: true, graceMs: 500 })
    t.eq('exit code is the command\'s', result.code, 0)
    t.eq('the background child was terminated', result.leftovers.group?.method, 'SIGTERM')
    t.eq('the group is empty', alive(-result.pid), false)
  }

  t.section('without reap, a deliberate daemon survives and the caller still returns')
  if (!setsid) t.skip('a setsid(1) daemon', 'no setsid binary on this host; the portable section below covers it')
  else {
    const started = Date.now()
    const result = await runProcess({ command: 'sh', args: ['-c', 'setsid sleep 3 & echo started'], closeGraceMs: 300 })
    t.ok('returns within the close grace', Date.now() - started < 3000, `${Date.now() - started} ms`)
    t.ok('reports that it stopped reading', result.leftovers.streamsAbandoned)
    t.eq('the output is complete', result.stdout, 'started\n')
  }

  t.section('the same with a daemon detached through node')
  {
    const started = Date.now()
    const result = await runProcess({ command: 'sh', args: ['-c', `${detached('inherit')}; echo started`], closeGraceMs: 300 })
    t.ok('returns within the close grace', Date.now() - started < 5000, `${Date.now() - started} ms`)
    t.ok('reports that it stopped reading', result.leftovers.streamsAbandoned)
    t.eq('no scan was asked for, and the record says so', result.leftovers.scan, { status: 'not-requested' })
  }

  t.section('large output is read in full')
  {
    const result = await runProcess({ command: 'sh', args: ['-c', 'seq 1 200000'], reap: true })
    t.eq('every line arrives', result.stdout.trim().split('\n').length, 200000)
    t.eq('and the streams closed normally', result.leftovers.streamsAbandoned, false)
  }

  t.section('a reap tag recorded by the caller is the one the command carries')
  {
    const tag = crypto.randomUUID()
    const result = await runProcess({ command: 'sh', args: ['-c', `echo $${REAP_TAG}`], reap: true, reapTag: tag })
    t.eq('the environment carries it', result.stdout.trim(), tag)
    t.eq('and the scan names it', result.leftovers.scan.tag, tag)
  }

  // darwin injected: ps -E answers from a listing built from what the test knows.
  // Real processes are spawned and terminated; only the listing is supplied.
  const uid = process.getuid()
  const row = (pid, command) => `${pid} ${uid} S ${command}`

  t.section('darwin injected: a listing with the exact tag terminates only those pids (P3-1)')
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-reap-darwin-'))
    const file = path.join(dir, 'escaped')
    const decoys = await Promise.all([0, 1, 2].map(() => new Promise((resolve) => { const c = spawn('sleep', ['30'], { stdio: 'ignore' }); c.once('spawn', () => resolve(c)) })))
    const platform = platformFor('darwin', { uid: () => uid, exec: async () => {
      const [pid, tag] = (await fs.readFile(file, 'utf8')).trim().split(' ')
      const rows = [
        row(process.pid, 'node test/run.mjs'),
        row(pid, `sleep 30 HOME=/Users/x ${REAP_TAG}=${tag}`),
        row(decoys[0].pid, `sleep 30 ${REAP_TAG}=${tag}0`),
        row(decoys[1].pid, `sleep 30 X_${REAP_TAG}=${tag}`),
        row(decoys[2].pid, `sleep 30 ${REAP_TAG}=${crypto.randomUUID()}`)
      ]
      return { ok: true, code: 0, stdout: rows.join('\n') + '\n' }
    } })
    // The escaped child writes its own pid and the tag it inherited.
    const writer = `${node} -e "const c=require('child_process').spawn('sleep',['30'],{detached:true,stdio:'ignore'});require('fs').writeFileSync(process.argv[1],c.pid+' '+process.env.${REAP_TAG});c.unref()" '${file}'`
    const result = await runProcess({ command: 'sh', args: ['-c', `${writer}; echo started`], reap: true, graceMs: 500, platform })
    const [escapedPid] = (await fs.readFile(file, 'utf8')).trim().split(' ')
    t.eq('only the tagged pid was found', result.leftovers.escaped, [Number(escapedPid)])
    t.eq('and it is gone', await running(Number(escapedPid)), false)
    t.eq('the decoys with near-miss tags are untouched', await Promise.all(decoys.map((d) => running(d.pid))), [true, true, true])
    t.eq('a complete parse counts as complete, named unproved, never plain proved (OP-2, option C)', [result.leftovers.scan.status, result.leftovers.scan.mechanism, result.leftovers.scan.reason ?? null], ['complete', 'unproved', null])
    t.eq('so it leaves no cleanup entry: the turn proceeds', unprovedScan(result.leftovers.scan), false)
    for (const d of decoys) d.kill('SIGKILL')
    await fs.rm(dir, { recursive: true, force: true })
  }

  t.section('darwin injected: a failed or incomplete listing is recorded as such (P3-2, P3-3)')
  {
    const failing = platformFor('darwin', { uid: () => uid, exec: async () => ({ ok: false, code: 1, stdout: '', error: 'ps: failed' }) })
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 200)
    const cancelled = await runProcess({ command: 'sh', args: ['-c', 'sleep 30'], signal: controller.signal, reap: true, graceMs: 500, platform: failing })
    t.eq('a failed ps: unavailable, never "none found", and short of proof on this host', [cancelled.leftovers.scan.status, cancelled.leftovers.scan.mechanism, cancelled.leftovers.scan.reason], ['unavailable', 'unproved', 'structural'])
    t.eq('and the cancellation does not claim complete termination', [cancelled.termination.descendants, cancelled.termination.complete], ['unavailable', false])
    const uninspected = platformFor('darwin', { uid: () => uid, exec: async () => ({ ok: true, code: 0, stdout: [row(process.pid, 'node'), row(4242, '(sleep)')].join('\n') }) })
    const result = await runProcess({ command: 'true', reap: true, platform: uninspected })
    t.eq('a row of ours ps could not inspect: incomplete, with the pid named', [result.leftovers.scan.status, result.leftovers.scan.reason, result.leftovers.scan.notInspected], ['incomplete', 'structural', [4242]])
    // auditor-1-empty-process-row: '4242 <uid> S' carries no command and no environment.
    const bare = platformFor('darwin', { uid: () => uid, exec: async () => ({ ok: true, code: 0, stdout: [row(process.pid, 'node'), `4242 ${uid} S`].join('\n') + '\n' }) })
    const unseen = (await runProcess({ command: 'true', reap: true, platform: bare })).leftovers.scan
    t.eq('a row of ours without its command field: incomplete, the pid named, never complete', [unseen.status, unseen.reason, unseen.notInspected], ['incomplete', 'structural', [4242]])
    t.eq('so it leaves a cleanup entry: the turn does not proceed', unprovedScan(unseen), true)
    const selfless = platformFor('darwin', { uid: () => uid, exec: async () => ({ ok: true, code: 0, stdout: row(4243, 'sleep 30') + '\n' }) })
    t.eq('a listing without our own pid: incomplete', (await runProcess({ command: 'true', reap: true, platform: selfless })).leftovers.scan.status, 'incomplete')
    const garbled = platformFor('darwin', { uid: () => uid, exec: async () => ({ ok: true, code: 0, stdout: [row(process.pid, 'node'), 'not a ps row'].join('\n') }) })
    t.eq('a malformed row: incomplete', (await runProcess({ command: 'true', reap: true, platform: garbled })).leftovers.scan.status, 'incomplete')
  }
}
