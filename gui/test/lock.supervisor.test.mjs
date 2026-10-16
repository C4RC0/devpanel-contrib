import fs from 'node:fs/promises'
import path from 'node:path'

import { currentOwner } from '../server/runtime/lock.mjs'
import { platformFor } from '../server/runtime/platform.mjs'
import { createSupervisor } from '../server/supervisor.mjs'
import { getRun } from '../server/runs-api.mjs'
import { engineFixture, cleanupFixtures } from './fakes/fixture.mjs'

/*
 * The supervisor's own reading of a run lock (P2-3): an owner whose liveness
 * cannot be established is held, never released at startup, never stopped from
 * here, and shown to the operator as such with the way out (removing the lock
 * by hand). On Linux an owner reads 'unknown' only without a pid or from
 * another host on the same boot; darwin is injected with a failing ps.
 */
const P = 'devpanel-project'

export default async function (t) {
  const f = await engineFixture()
  // Every pid answers kill(0) (a live process); ps fails for all of them.
  const darwinFailing = platformFor('darwin', { kill: () => {}, exec: async (command) => command.endsWith('sysctl')
    ? { ok: true, code: 0, stdout: '0f2c1a3b-9d4e-4f5a-8b6c-7d8e9f0a1b2c\n' }
    : { ok: false, code: 1, stdout: '', error: 'ps failed' } })
  // Another process's lock (not this server's own pid, which it would read as its own).
  const foreign = 424242
  const cases = [
    ['linux: an owner on another host of the same boot', platformFor('linux'), async (runId) => ({ ...(await currentOwner(runId, { platform: platformFor('linux') })), pid: foreign, host: 'somewhere-else' })],
    ['darwin injected: ps fails for a live owner', darwinFailing, async (runId) => ({ ...(await currentOwner(runId, { platform: darwinFailing })), pid: foreign, processStartedAt: 'lstart:1' })]
  ]
  for (const [label, platform, ownerFor] of cases) {
    t.section(label)
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
    await fs.writeFile(lock, JSON.stringify({ purpose: 'run', token: 'held', owner: await ownerFor(runId) }))
    const supervisor = createSupervisor({ issues: f.issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir: path.dirname(f.projectPath), configRoot: f.configRoot, platform })

    await supervisor.reconcile()
    t.eq('startup leaves the lock where it is', JSON.parse(await fs.readFile(lock, 'utf8')).token, 'held')
    const run = JSON.parse(await fs.readFile(path.join(issue.path, 'runs', runId, 'run.json'), 'utf8'))
    t.eq('and the run is not marked recovery-required', [run.status, run.blockedReason ?? null], ['running', null])
    const listed = (await supervisor.liveAgents()).find((r) => r.runId === runId)
    t.eq('live agents say the owner cannot be established', listed?.ownership, 'owner-unknown')
    const stopped = await supervisor.stop({ project: P, issueId: issue.id, runId }).catch((e) => e)
    t.eq('stop is refused', stopped?.status, 409)
    const detail = await getRun(issue.path, runId, { issues: f.issues, project: P, issueId: issue.id, isActive: false, platform })
    t.ok('the explanation says so', /owner cannot be established/i.test(detail.explanation?.headline ?? ''), detail.explanation?.headline)
    t.ok('and names the lock an operator may remove', (detail.explanation?.next ?? '').includes('.run.lock'), detail.explanation?.next)
    await fs.rm(lock)
  }
  await cleanupFixtures()
}
