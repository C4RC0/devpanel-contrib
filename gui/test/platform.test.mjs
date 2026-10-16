import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { platformFor, hostPlatform, parseLstart, REAP_TAG } from '../server/runtime/platform.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SERVER = path.join(HERE, '..', 'server')
const errno = (code) => Object.assign(new Error(code), { code })

/** A fake exec answering by command, the way execFile would, never reaching a real CLI. */
const fakeExec = (answers) => async (command, args) => {
  const answer = answers[`${path.basename(command)} ${args.join(' ')}`] ?? answers[path.basename(command)]
  if (!answer) return { ok: false, code: 127, stdout: '', stderr: '', error: `no such command: ${command}` }
  return typeof answer === 'function' ? answer(args) : answer
}
const ok = (stdout) => ({ ok: true, code: 0, stdout, stderr: '', error: null })
const failed = (code = 1, stderr = 'ps: failed') => ({ ok: false, code, stdout: '', stderr, error: stderr })

export default async function (t) {
  const platformBefore = process.platform

  t.section('linux, against this host (verbatim probes)')
  if (process.platform !== 'linux') t.skip('the real /proc probes', 'not linux')
  else {
    const linux = platformFor('linux')
    const bootId = (await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    t.eq('boot id is the kernel\'s', await linux.bootId(), bootId)
    const stat = await fs.readFile(`/proc/${process.pid}/stat`, 'utf8')
    t.eq('own start time is field 22 of /proc/<pid>/stat', await linux.processStart(process.pid), { state: 'present', startedAt: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] })
    const tag = crypto.randomUUID()
    const child = spawn('sleep', ['30'], { env: { ...process.env, [REAP_TAG]: tag }, stdio: 'ignore' })
    await new Promise((resolve) => child.once('spawn', resolve))
    const found = await linux.taggedProcesses(tag)
    t.eq('a tagged process is found by its environment', [found.status, found.pids], ['complete', [child.pid]])
    t.eq('another tag finds nothing', (await linux.taggedProcesses(crypto.randomUUID())).pids, [])
    child.kill('SIGKILL')
    t.eq('the mount table is read', (await linux.mountTable()).status, 'read')
  }

  t.section('linux, injected: outcomes moved verbatim')
  {
    const reads = []
    const stat = (body) => platformFor('linux', { readFile: async (file) => { reads.push(file); if (body instanceof Error) throw body; return body } })
    t.eq('no /proc entry: absent', await stat(errno('ENOENT')).processStart(7), { state: 'absent' })
    t.eq('an unreadable entry: absent, as before (T2(i))', await stat(errno('EACCES')).processStart(7), { state: 'absent' })
    t.eq('a stat without field 22: absent, as before', await stat('7 (x) S 1 2').processStart(7), { state: 'absent' })
    t.eq('the boot id falls back to the hostname', (await stat(errno('ENOENT')).bootId()).startsWith('no-boot-id:'), true)
    const tag = 'abc'
    // An explicit self pid, never the runner's: the tagged pid 3 must not be ours.
    const SELF = 4242
    const proc = platformFor('linux', {
      readdir: async () => ['1', '2', '3', 'self', String(SELF)],
      readFile: async (file) => {
        if (file === '/proc/1/environ') throw errno('EACCES')
        if (file === '/proc/2/environ') throw errno('ENOENT')
        if (file === '/proc/3/environ') return Buffer.from(`A=1\0${REAP_TAG}=${tag}\0`)
        throw errno('ENOENT')
      }
    })
    t.eq('entries that are gone or not ours do not make the scan incomplete', await proc.taggedProcesses(tag, { self: SELF }), { status: 'complete', method: 'proc-environ', pids: [3] })
    const unlisted = await platformFor('linux', { readdir: async () => { throw errno('EACCES') } }).taggedProcesses(tag)
    t.eq('a /proc that cannot be listed is unavailable, never "none"', [unlisted.status, unlisted.pids], ['unavailable', []])
    const mounts = await platformFor('linux', { readFile: async () => { throw errno('ENOENT') } }).mountTable()
    t.eq('an unreadable mount table says so and yields no mounts', [mounts.status, mounts.text], ['unreadable', ''])
    t.eq('linux descendant scans are proved', platformFor('linux').descendantScan.proved, true)
    t.eq('and nothing is unavailable', platformFor('linux').describe(), { platform: 'linux', startTimePrecision: 'clock-tick', descendantScan: 'proved', unavailable: [], notApplicable: [] })
  }

  t.section('darwin, injected: boot identity')
  {
    const uuid = '0F2C1A3B-9D4E-4F5A-8B6C-7D8E9F0A1B2C'
    t.eq('kern.bootsessionuuid is the boot identity', await platformFor('darwin', { exec: fakeExec({ sysctl: ok(`${uuid}\n`) }) }).bootId(), `darwin-boot:${uuid.toLowerCase()}`)
    t.eq('a malformed answer is no identity, not a stand-in', await platformFor('darwin', { exec: fakeExec({ sysctl: ok('{ sec = 1 }\n') }) }).bootId(), null)
    let calls = 0
    const flaky = platformFor('darwin', { exec: fakeExec({ sysctl: () => (++calls === 1 ? failed() : ok(uuid)) }) })
    t.eq('a failed sysctl is no identity', await flaky.bootId(), null)
    t.eq('and is not cached', await flaky.bootId(), `darwin-boot:${uuid.toLowerCase()}`)
  }

  t.section('darwin, injected: process start (whole seconds, C locale, UTC)')
  {
    t.eq('lstart is read as epoch seconds', parseLstart('Thu Oct 16 07:42:29 2026'), Date.UTC(2026, 9, 16, 7, 42, 29) / 1000)
    t.eq('a space-padded day is read', parseLstart('Fri Oct  2 01:02:03 2026'), Date.UTC(2026, 9, 2, 1, 2, 3) / 1000)
    t.eq('an impossible date is refused', parseLstart('Sat Feb 31 01:02:03 2026'), null)
    t.eq('a start without seconds is refused', parseLstart('7:42AM'), null)
    const alive = () => {}
    const gone = () => { throw errno('ESRCH') }
    const start = (kill, ps) => platformFor('darwin', { kill, exec: fakeExec({ ps }) }).processStart(42)
    t.eq('proven absence', await start(gone, ok('')), { state: 'absent' })
    t.eq('a live process has its start time', await start(alive, ok('Thu Oct 16 07:42:29 2026\n')), { state: 'present', startedAt: `lstart:${Date.UTC(2026, 9, 16, 7, 42, 29) / 1000}` })
    t.eq('another user\'s process (EPERM) is still read', (await start(() => { throw errno('EPERM') }, ok('Thu Oct 16 07:42:29 2026'))).state, 'present')
    t.eq('a start time without seconds is unknown', (await start(alive, ok('7:42AM'))).state, 'unknown')
    t.eq('a failed ps is unknown', (await start(alive, failed())).state, 'unknown')
    let n = 0
    t.eq('gone between the two looks is absence', await start(() => { if (++n > 1) throw errno('ESRCH') }, failed(1, '')), { state: 'absent' })
    t.eq('a signal that fails otherwise is unknown', (await start(() => { throw errno('EINVAL') }, ok(''))).state, 'unknown')
  }

  t.section('darwin, injected: tagged-process listing')
  {
    const tag = '11111111-2222-3333-4444-555555555555'
    const me = 501
    const scan = (listing) => platformFor('darwin', { uid: () => me, exec: fakeExec({ ps: typeof listing === 'string' ? ok(listing) : listing }) }).taggedProcesses(tag, { self: 100 })
    const row = (pid, uid, stat, command) => `${String(pid).padStart(5)} ${String(uid).padStart(5)} ${stat.padEnd(4)} ${command}`
    const listing = (...rows) => [row(100, me, 'S', 'node server/index.js PATH=/usr/bin'), ...rows].join('\n') + '\n'
    const exact = await scan(listing(
      row(200, me, 'S', `sleep 30 HOME=/Users/x ${REAP_TAG}=${tag} PATH=/usr/bin`),
      row(201, me, 'S', `sleep 30 ${REAP_TAG}=${tag}0`),
      row(202, me, 'S', `sleep 30 X_${REAP_TAG}=${tag}`),
      row(203, me, 'S', `sleep 30 ${REAP_TAG}=${crypto.randomUUID()}`),
      row(204, 0, 'Ss', '(launchd)'),
      row(205, me, 'Z', '(sleep)')))
    t.eq('only the exact tag matches; another user\'s and zombie rows are out of scope', exact, { status: 'complete', method: 'ps-E', pids: [200] })
    const uninspected = await scan(listing(row(200, me, 'S', `sleep 30 ${REAP_TAG}=${tag}`), row(206, me, 'S', '(sleep)')))
    t.eq('a row of ours that ps could not inspect makes the scan incomplete, never complete', [uninspected.status, uninspected.pids, uninspected.notInspected], ['incomplete', [200], [206]])
    // auditor-1-empty-process-row: a row of ours with no command and environment field was never inspected.
    for (const bare of ['4242 501 S', row(4242, me, 'S', '')]) {
      const empty = await scan(listing(bare))
      t.eq(`a row of ours without its command field (${JSON.stringify(bare)}) is incomplete, naming the pid`, [empty.status, empty.pids, empty.notInspected], ['incomplete', [], [4242]])
    }
    t.eq('a listing without this process is incomplete', (await scan(row(200, me, 'S', 'sleep 30') + '\n')).status, 'incomplete')
    t.eq('an unreadable row is incomplete', (await scan(listing('garbage row'))).status, 'incomplete')
    t.eq('a failed ps is unavailable', (await scan(failed())).status, 'unavailable')
  }

  t.section('darwin, injected: what is not applicable or not proved')
  {
    const reads = []
    const darwin = platformFor('darwin', { readFile: async (file) => { reads.push(file); return '' }, exec: fakeExec({}) })
    t.eq('mount discovery is not applicable', (await darwin.mountTable()).status, 'not-applicable')
    t.eq('and nothing was read', reads, [])
    t.eq('its descendant scan is not proved (OP-2)', darwin.descendantScan.proved, false)
    t.eq('the run record names what is unavailable', darwin.describe(), { platform: 'darwin', startTimePrecision: 'second', descendantScan: 'unproved', unavailable: ['seatFence', 'offlineWrapper', 'geminiReadOnlyRoots', 'projectSandboxProbe', 'descendantScanProof'], notApplicable: ['mountDiscovery'] })
    t.eq('darwin has no runtime temp prefix and no bubblewrap', [darwin.runtimeTempPrefix, darwin.bubblewrap], [null, false])
    t.eq('the gemini system directory is the platform\'s', [darwin.geminiSystemConfigDir, platformFor('linux').geminiSystemConfigDir, platformFor('win32').geminiSystemConfigDir], ['/Library/Application Support/GeminiCli', '/etc/gemini-cli', 'C:\\ProgramData\\gemini-cli'])
  }

  t.section('one module, chosen without touching process.platform')
  {
    t.eq('the host platform is this host\'s', hostPlatform().id, process.platform === 'darwin' ? 'darwin' : process.platform)
    t.eq('process.platform was never changed', process.platform, platformBefore)
    const source = await fs.readFile(path.join(SERVER, 'runtime', 'platform.mjs'), 'utf8')
    const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
    t.ok('platform.mjs imports only node builtins, so runProcess cannot be in a cycle with it', imports.length > 0 && imports.every((s) => s.startsWith('node:')), imports.join(', '))
    // P1-1: no '/proc/' read outside platform.mjs, except scripts run over SSH (remote-check-process.mjs).
    const offenders = []
    const walk = async (dir) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) { await walk(full); continue }
        if (!/\.(m?js)$/.test(entry.name) || ['platform.mjs', 'remote-check-process.mjs'].includes(entry.name)) continue
        const text = await fs.readFile(full, 'utf8')
        text.split('\n').forEach((line, i) => { if (/\/proc\//.test(line)) offenders.push(`${path.relative(SERVER, full)}:${i + 1}`) })
      }
    }
    await walk(SERVER)
    t.eq('no /proc/ path outside the platform module and remote scripts', offenders, [])
  }
}
