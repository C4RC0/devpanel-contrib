import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { engineFixture, cleanupFixtures } from './fakes/fixture.mjs'

export const name = 'harness loading — an adapter that cannot be imported is named, not reported missing'

const NL = String.fromCharCode(10)

export default async (t) => {
  const sharedControl = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-fake-control-')), 'control.json')
  process.env.DEVPANEL_FAKE_CONTROL = sharedControl

  t.section('1. an adapter whose import fails refuses preflight with the import error and the restart remedy')
  {
    const f = await engineFixture({ playbook: 'analysis' })
    const projectsDir = path.join(f.issuesDir, 'projects')
    await fs.mkdir(projectsDir, { recursive: true })
    await fs.symlink(f.projectPath, path.join(projectsDir, 'devpanel-project'))
    await fs.writeFile(sharedControl, JSON.stringify({ ledger: path.join(f.issuesDir, 'ledger.jsonl'), delayMs: 0 }))
    // What a running service sees after an adapter on disk was updated to need a
    // newer export of a module the service already holds: the import throws.
    const shared = path.join(process.cwd(), '..', 'harness', 'shared.mjs')
    const fake = path.join(process.cwd(), 'test', 'fakes', 'harness-module.mjs')
    await fs.writeFile(path.join(f.configRoot, 'harness', 'fake.mjs'), `import { exportAddedAfterStart } from ${JSON.stringify(shared)}${NL}export * from ${JSON.stringify(fake)}${NL}`)
    const { createSupervisor } = await import('../server/supervisor.mjs')
    const supervisor = createSupervisor({ issues: f.issues, harnessDir: path.join(f.configRoot, 'harness'), projectsDir, configRoot: f.configRoot })
    const started = await supervisor.start({ project: 'devpanel-project', issueId: f.issue.id, playbookId: 'analysis', configRoot: f.configRoot })
    await supervisor.settle()
    const { readRun } = await import('../server/runtime/store.mjs')
    const run = await readRun(f.issuePath, started.runId)
    t.eq('the run is refused at preflight', `${run.status}/${run.blockedReason}`, 'failed/preflight-refused')
    const detail = run.preflight?.detail ?? ''
    t.ok('the refusal says the harness failed to load', /harness "fake" failed to load/.test(detail), detail)
    t.ok('with the import error', /exportAddedAfterStart/.test(detail), detail)
    t.ok('and the remedy', /restart devpanel/.test(detail), detail)
    t.ok('not that the adapter is missing', !/no adapter for harness/.test(detail), detail)
  }

  delete process.env.DEVPANEL_FAKE_CONTROL
  await fs.rm(path.dirname(sharedControl), { recursive: true, force: true })
  await cleanupFixtures()
}
