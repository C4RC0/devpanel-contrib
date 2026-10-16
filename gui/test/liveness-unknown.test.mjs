import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { acquire, currentOwner, ownerLiveness } from '../server/runtime/lock.mjs'
import { parseLstart, platformFor } from '../server/runtime/platform.mjs'
import { createSupervisor } from '../server/supervisor.mjs'
import { engineFixture, cleanupFixtures } from './fakes/fixture.mjs'

/*
 * "Unknown is never taken over", at its two edges: a start time with any
 * component out of range is not a start time (auditor-1-malformed-lstart), and
 * a lock whose pid happens to be this server's own is not this server's unless
 * its liveness is proved (auditor-1-unknown-owner-pid). darwin is injected.
 */
const P = 'devpanel-project'
const BOOT = '0f2c1a3b-9d4e-4f5a-8b6c-7d8e9f0a1b2c'
const errno = (code) => Object.assign(new Error(code), { code })

export default async function (t) {
  t.section('L1. an lstart with any component out of range reads as no time')
  {
    t.eq('a valid time parses', parseLstart('Thu Oct 16 07:42:29 2026'), Date.UTC(2026, 9, 16, 7, 42, 29) / 1000)
    t.eq('a padded single-digit day parses', parseLstart('Fri Oct  2 07:42:29 2026'), Date.UTC(2026, 9, 2, 7, 42, 29) / 1000)
    for (const text of ['Thu Oct 16 07:42:99 2026', 'Thu Oct 16 07:42:60 2026', 'Thu Oct 16 07:60:29 2026', 'Thu Oct 16 07:99:29 2026',
      'Thu Oct 16 24:42:29 2026', 'Thu Oct 16 99:42:29 2026', 'Thu Oct 32 07:42:29 2026', 'Thu Oct  0 07:42:29 2026', 'Mon Feb 30 07:42:29 2026']) {
      t.eq(`"${text}": null`, parseLstart(text), null)
    }
  }

  t.section('L2. a live owner whose lstart is out of range is unknown, and is not taken over')
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-lstart-'))
    const file = path.join(dir, 'run.lock')
    const OWNER = 4242
    const platform = platformFor('darwin', {
      kill: (pid) => { if (![process.pid, OWNER].includes(pid)) throw errno('ESRCH') },
      exec: async (command, args) => {
        if (command.endsWith('sysctl')) return { ok: true, code: 0, stdout: `${BOOT}\n` }
        const pid = Number(args.at(-1))
        return { ok: true, code: 0, stdout: `${pid === OWNER ? 'Thu Oct 16 07:42:99 2026' : 'Thu Oct 16 07:42:29 2026'}\n` }
      }
    })
    const owner = { ...(await currentOwner('run-x', { platform })), pid: OWNER, processStartedAt: `lstart:${Date.UTC(2026, 9, 16, 7, 42, 39) / 1000}` }
    t.eq('its liveness is unknown', await ownerLiveness(owner, { platform }), 'unknown')
    await fs.writeFile(file, JSON.stringify({ purpose: 'run', token: 'held', owner }))
    const refused = await acquire(file, { purpose: 'run', platform }).catch((e) => e)
    t.ok('acquire is refused', refused instanceof Error, refused?.token)
    t.eq('the lock is left as it was', JSON.parse(await fs.readFile(file, 'utf8')).token, 'held')
    await fs.rm(dir, { recursive: true, force: true })
  }

  t.section('L3. startup keeps an unknown owner\'s lock even when its pid is this server\'s')
  {
    const f = await engineFixture()
    const darwinFailing = platformFor('darwin', { kill: () => {}, exec: async (command) => command.endsWith('sysctl')
      ? { ok: true, code: 0, stdout: `${BOOT}\n` }
      : { ok: false, code: 1, stdout: '', error: 'ps failed' } })
    const linux = platformFor('linux')
    const cases = [
      ['darwin injected: ps fails, the lock names this server\'s pid', darwinFailing, async (runId) => ({ ...(await currentOwner(runId, { platform: darwinFailing })), pid: process.pid, processStartedAt: 'lstart:1' })],
      ['linux: the lock names this server\'s pid on another host of the same boot', linux, async (runId) => ({ ...(await currentOwner(runId, { platform: linux })), pid: process.pid, host: 'somewhere-else' })]
    ]
    for (const [label, platform, ownerFor] of cases) {
      if (label.startsWith('linux') && process.platform !== 'linux') { t.skip(label, 'not linux'); continue }
      const issue = await f.issues.createIssue(P, { name: label })
      const runId = `2026-01-01T00-00-00-000Z-${Math.random().toString(16).slice(2, 10)}`
      await fs.mkdir(path.join(issue.path, 'runs', runId), { recursive: true })
      await fs.writeFile(path.join(issue.path, 'runs', runId, 'run.json'), JSON.stringify({
        runId, issue: { project: P, id: issue.id }, playbook: { id: 'implementation', strategy: 'implementation' },
        status: 'running', startedAt: new Date().toISOString(), phase: { id: 'implement-review', round: 0 },
        participants: { implementer: { role: 'implementer', model: 'opus-5-5', harness: 'fake', state: 'ready' } },
        steps: [], revisions: [], approvals: [], checkResults: [], budgets: { limits: {}, used: {} }
      }))
      const lock = path.join(issue.path, '.run.lock')
      const owner = await ownerFor(runId)
      await fs.writeFile(lock, JSON.stringify({ purpose: 'run', token: 'held', owner }))
      const supervisor = createSupervisor({ issues: f.issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir: path.dirname(f.projectPath), configRoot: f.configRoot, platform })
      t.eq(`${label}: the owner is unknown`, await ownerLiveness(owner, { platform }), 'unknown')
      await supervisor.reconcile()
      t.eq(`${label}: startup leaves the lock where it is`, JSON.parse(await fs.readFile(lock, 'utf8')).token, 'held')
      const run = JSON.parse(await fs.readFile(path.join(issue.path, 'runs', runId, 'run.json'), 'utf8'))
      t.eq(`${label}: the run is not marked recovery-required`, [run.status, run.blockedReason ?? null], ['running', null])
      const stopped = await supervisor.stop({ project: P, issueId: issue.id, runId }).catch((e) => e)
      t.eq(`${label}: stop is refused`, stopped?.status, 409)
      t.eq(`${label}: and the lock still stands`, JSON.parse(await fs.readFile(lock, 'utf8')).token, 'held')
      await fs.rm(lock)
    }
  }

  await cleanupFixtures()
}
