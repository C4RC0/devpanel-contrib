import fs from 'node:fs/promises'
import path from 'node:path'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { engineFixture } from './fakes/fixture.mjs'
import { amendRetained } from '../server/runtime/retained-amendment.mjs'

export default async t => {
  const f = await engineFixture({ playbook: 'implementation' })
  const engine = await startRun({ ...f, deliveryProvider: f.delivery })
  await engine.initialiseIntegrity()
  engine.run.status = 'blocked'
  engine.run.blockedReason = 'budget-exhausted'
  engine.run.endedAt = engine.clock.iso()
  const snapshot = JSON.stringify(engine.snapshot)
  const sessions = JSON.stringify(engine.run.participants)
  const file = 'source.txt'
  const before = await fs.readFile(path.join(engine.run.workspace.path, file), 'utf8')
  let refused = false
  try { await amendRetained(engine, { edits: [{ path: file, before: 'wrong', after: 'changed' }], actor: 'operator', reason: 'repair' }) } catch { refused = true }
  t.ok('wrong preimage is refused without editing', refused)
  t.eq('source intact', await fs.readFile(path.join(engine.run.workspace.path, file), 'utf8'), before)
  const record = await amendRetained(engine, { edits: [{ path: file, before, after: before + '\noperator fix\n' }], actor: 'operator', reason: 'repair regression' })
  t.eq('amendment recorded honestly', record.status, 'completed')
  t.eq('integrity is clear after verified amendment', engine.run.integrity.status, 'clear')
  t.ok('new revision recorded', engine.run.revisions.at(-1)?.byStep === record.id)
  t.eq('sessions preserved', JSON.stringify(engine.run.participants), sessions)
  t.eq('launch snapshot unchanged', JSON.stringify(engine.snapshot), snapshot)
  const target = { ...engine.snapshot.checks.target, commands: [{ id: 'amended-check', run: 'echo verified', timeoutSeconds: 10 }] }
  engine.run.checkResults = [{ revision: record.revision, result: 'passed' }]
  await amendRetained(engine, { target, actor: 'operator', reason: 'correct reporting command' })
  t.eq('old gate pass cannot skip new commands', engine.run.checkResults, [])
  t.ok('old receipt remains in history', engine.run.priorCheckResults.some(c => c.revision === record.revision))
  t.eq('replacement commands recorded outside snapshot', engine.run.checkRefresh.target.commands[0].id, 'amended-check')
  t.eq('check change also preserves launch snapshot', JSON.stringify(engine.snapshot), snapshot)
  await engine.resumeExecution({ budgets: { maxSteps: 150 } })
  t.eq('amended candidate passes resume integrity check', engine.run.status, 'pending')
  await releaseWorkspace(engine)
}
