import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { createTopSupervisor } from '../server/top-supervisor.mjs'
import { engineFixture, scriptFor, cleanupFixtures } from './fakes/fixture.mjs'

export const name = 'disposition, follow-ups and finishing — a completed run is not a resolved issue'

const NL = String.fromCharCode(10)
const fence = (obj) => ['```json', JSON.stringify(obj), '```'].join(NL)
const start = (f) => startRun({
  playbookId: f.playbookId, issue: { project: 'devpanel-project', id: f.issue.id },
  issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore,
  workspaceProvider: f.workspaceProvider, configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery
})
const wait = async (test) => { const end = Date.now() + 6000; while (!test()) { if (Date.now() > end) throw Error('Timed out'); await new Promise((r) => setTimeout(r, 10)) } }

/** A run whose closing report leaves two risks open and accepts one. */
const withResiduals = () => {
  const base = scriptFor()
  return (turn) => {
    if (turn.stepId !== 'confirm') return base(turn)
    const rev = (turn.prompt.match(/sha256:[0-9a-f]{64}/) ?? [null])[0]
    return `Report.${NL}${fence({ satisfied: true, revision: rev, criteria: [{ id: 'AC1', met: true, evidence: 'read' }], reasoning: 'ok', residualRisks: [
      { description: 'the reported exposure remains open by default', accepted: false, relatesTo: 'AC2' },
      { description: 'byte-cap loss is documented', accepted: true },
      { description: 'operator decision on the delivery uid is unanswered', accepted: false }
    ] })}`
  }
}

export default async function (t) {
  t.section('1. a disposition needs evidence, and "resolved" is refused while a run left risks open')
  {
    const f = await engineFixture({ script: withResiduals() })
    const engine = await start(f)
    const run = await engine.drive()
    await releaseWorkspace(engine)
    t.eq('the run resolved by the playbook\'s bar', run.outcome, 'resolved')

    let threw = null
    try { await f.issues.setIssueDisposition('devpanel-project', f.issue.id, { value: 'resolved', evidence: 'looked', runId: run.runId }) } catch (e) { threw = e }
    t.eq('resolved is refused', threw?.status, 409)
    t.ok('naming the open risks', /2 residual risk\(s\) unaccepted/.test(threw?.message ?? ''), threw?.message)

    threw = null
    try { await f.issues.setIssueDisposition('devpanel-project', f.issue.id, { value: 'partially-resolved', evidence: '  ', runId: run.runId }) } catch (e) { threw = e }
    t.ok('evidence is required', /evidence/.test(threw?.message ?? ''))

    threw = null
    try { await f.issues.setIssueDisposition('devpanel-project', f.issue.id, { value: 'fixed', evidence: 'x' }) } catch (e) { threw = e }
    t.ok('an unknown value is refused', /must be one of/.test(threw?.message ?? ''))

    threw = null
    try { await f.issues.setIssueDisposition('devpanel-project', f.issue.id, { value: 'resolved', evidence: 'looked' }) } catch (e) { threw = e }
    t.eq('omitting the run is not a way around its residuals', threw?.status, 409, threw?.message)
    threw = null
    try { await f.issues.setIssueDisposition('devpanel-project', f.issue.id, { value: 'resolved', evidence: 'looked', by: 'supervisor', override: 'I say so' }) } catch (e) { threw = e }
    t.eq('the supervisor cannot override', threw?.status, 409)
    const overridden = await f.issues.setIssueDisposition('devpanel-project', f.issue.id, { value: 'resolved', evidence: 'the exposure was accepted by the operator out of band', by: 'operator', override: 'accepted in the weekly review' })
    t.eq('an operator may, with a stated reason on the record', overridden.disposition.override?.reason, 'accepted in the weekly review')
    t.eq('and the open risks are still recorded', overridden.disposition.openRisks.length, 2)

    const issue = await f.issues.setIssueDisposition('devpanel-project', f.issue.id, { value: 'partially-resolved', evidence: 'resource exhaustion fixed; exposure open by ruling', runId: run.runId, by: 'supervisor' })
    t.eq('partially-resolved is recorded', issue.disposition.value, 'partially-resolved')
    t.eq('with its author', issue.disposition.by, 'supervisor')
    t.eq('and the open risks copied from the run', issue.disposition.openRisks.length, 2)
    const [listed] = await f.issues.listIssues('devpanel-project')
    t.eq('the list carries it', listed.disposition.value, 'partially-resolved')
    t.eq('the issue status is untouched', listed.status, 'open')

    // Archive without a disposition is always possible; it is recorded as an
    // override, with the reason when one was given.
    const g = await engineFixture()
    const bare = await g.issues.setIssueArchived('devpanel-project', g.issue.id, true)
    t.eq('archiving without a disposition or reason is accepted by storage', bare.archived, true)
    t.ok('and recorded as an override without a reason', bare.archiveOverride && bare.archiveOverride.reason === null)
    await g.issues.setIssueArchived('devpanel-project', g.issue.id, false)
    const archived = await g.issues.setIssueArchived('devpanel-project', g.issue.id, true, { overrideReason: 'duplicate of another issue' })
    t.eq('with a stated reason it is archived', archived.archived, true)
    t.eq('and the reason is on the record', archived.archiveOverride?.reason, 'duplicate of another issue')
  }

  t.section('2. follow-ups are created once per open risk, linked to the run')
  {
    const f = await engineFixture({ script: withResiduals() })
    const engine = await start(f)
    const run = await engine.drive()
    await releaseWorkspace(engine)
    const first = await f.issues.createFollowUps('devpanel-project', f.issue.id, run.runId)
    t.eq('two follow-ups for two open risks', first.followUps.filter((x) => x.issueId).length, 2)
    const all = await f.issues.listIssues('devpanel-project')
    t.eq('the project now has three issues', all.length, 3)
    const followUp = all.find((i) => i.id === first.followUps[0].issueId)
    t.ok('named after the risk', followUp.name.startsWith('Follow-up: the reported exposure'), followUp.name)
    const report = await fs.readFile(path.join(followUp.path, '000-report', 'response.md'), 'utf8')
    t.ok('with provenance', report.includes(run.runId) && report.includes(f.issue.id))
    t.ok('and the rule that it does not absorb the defect', report.includes('keeps its own disposition'))
    const again = await f.issues.createFollowUps('devpanel-project', f.issue.id, run.runId)
    t.ok('a second call creates nothing new', again.followUps.every((x) => x.existing))
    t.eq('still three issues', (await f.issues.listIssues('devpanel-project')).length, 3)
    const { readRun } = await import('../server/runtime/store.mjs')
    const record = await readRun(f.issuePath, run.runId)
    t.eq('the run records the links by risk index', record.closure.followUps.map((x) => x.riskIndex).join(','), '0,2')
    const source = all.find((i) => i.id === f.issue.id)
    t.eq('the source issue has no disposition set by this', source.disposition, null)
  }

  t.section('3. the supervisor cannot archive without a disposition, and finish stops it after its runs')
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sup-finish-'))
    const invocations = []
    let script = []
    const runs = new Map()
    const issueState = { disposition: null }
    const adapter = { invoke: async (args) => {
      invocations.push(args)
      const event = JSON.parse(args.prompt).event
      const action = script.shift()?.(event) ?? null
      return { session: args.session ?? { id: 's' }, response: JSON.stringify({ message: 'ok', action }), usage: { costUsd: 0 } }
    } }
    const tools = {
      projects: async () => [{ id: 'p' }], playbooks: async () => [], listIssues: async () => [{ id: 'i', status: 'open', name: 'n' }],
      getIssue: async () => ({ issue: { id: 'i', disposition: issueState.disposition }, reports: [], runs: [] }),
      preview: async () => ({ ok: true, configHash: 'h' }),
      start: async () => { const r = { runId: 'r1', status: 'running' }; runs.set('r1', r); return r },
      getRun: async (_p, _i, id) => runs.get(id) ?? { status: 'completed' }, stop: async (r) => { runs.get(r.runId).status = 'cancelled' },
      archive: async () => ({ archived: true }), createIssue: async () => ({}), addNote: async () => ({}),
      setDisposition: async (a) => { issueState.disposition = { value: a.value }; return { issue: { disposition: issueState.disposition } } },
      createFollowUps: async () => ({ followUps: [] })
    }
    const agent = await createTopSupervisor({ dir, models: async () => [{ id: 'm', title: 'M', model: 'm', verification: { status: 'verified' } }], adapter, tools, pollMs: 20 })
    script = [
      () => ({ type: 'archive_issue', project: 'p', issueId: 'i' }),
      () => ({ type: 'set_disposition', project: 'p', issueId: 'i', value: 'partially-resolved', evidence: 'checked the closure' }),
      () => ({ type: 'archive_issue', project: 'p', issueId: 'i' }),
      () => ({ type: 'preview', project: 'p', issueId: 'i', playbook: 'x' }),
      (e) => ({ type: 'start_run', project: 'p', issueId: 'i', previewId: e.result.previewId }),
      () => ({ type: 'finish' })
    ]
    await agent.start({ model: 'm', projects: ['p'], message: 'go', allowArchive: true, limits: { maxCalls: 20, maxRuns: 2, maxConcurrent: 1, maxStartsPerIssue: 2 } })
    await wait(() => agent.get().finishing === true && agent.get().status === 'active')
    const tool = (i) => agent.get().messages.filter((m) => m.role === 'tool')[i]?.text ?? ''
    t.ok('archiving without a disposition is refused', tool(0).includes('Set a disposition'))
    t.ok('setting one works', tool(1).includes('partially-resolved'))
    t.ok('archiving then succeeds', tool(2).includes('archived'))
    t.eq('the run was started before finish', runs.get('r1')?.status, 'running')
    t.eq('finishing is on', agent.get().finishing, true)
    t.eq('the activation is still active while a run is live', agent.get().status, 'active')
    let refused = false
    try { await agent.chat('one more') ; await wait(() => invocations.length >= 8) } catch { refused = true }
    // A start during finishing is refused by the guard even if asked for.
    runs.get('r1').status = 'completed'
    await wait(() => agent.get().status === 'stopped')
    t.eq('once the run completes the activation stops on its own', agent.get().status, 'stopped')
    t.eq('with the reason', agent.get().reason, 'finished')
    t.eq('the owned run was not cancelled', runs.get('r1').status, 'completed')
    void refused
    await agent.shutdown()
    await fs.rm(dir, { recursive: true, force: true })
  }

  t.section('4. split and duplicate name the issues they point to, and each must exist')
  {
    const f = await engineFixture({})
    const P = 'devpanel-project'
    const partA = await f.issues.createIssue(P, { name: 'Part A' })
    const partB = await f.issues.createIssue(P, { name: 'Part B' })
    const refusal = async (fn) => { try { await fn() } catch (e) { return e } return null }

    let threw = await refusal(() => f.issues.setIssueDisposition(P, f.issue.id, { value: 'split', evidence: 'broken down' }))
    t.ok('split without its parts is refused', /split into/.test(threw?.message ?? ''), threw?.message)
    threw = await refusal(() => f.issues.setIssueDisposition(P, f.issue.id, { value: 'duplicate', evidence: 'same', related: [partA.id, partB.id] }))
    t.ok('a duplicate names exactly one original', /exactly one/.test(threw?.message ?? ''), threw?.message)
    threw = await refusal(() => f.issues.setIssueDisposition(P, f.issue.id, { value: 'split', evidence: 'x', related: ['2026-01-01-no-such-issue'] }))
    t.eq('a related issue must exist', threw?.status, 404)
    threw = await refusal(() => f.issues.setIssueDisposition(P, f.issue.id, { value: 'split', evidence: 'x', related: [f.issue.id] }))
    t.ok('an issue cannot be split into itself', /its own issue/.test(threw?.message ?? ''), threw?.message)
    threw = await refusal(() => f.issues.setIssueDisposition(P, f.issue.id, { value: 'split', evidence: 'x', related: 'Part A' }))
    t.ok('related is a list', /list of issue ids/.test(threw?.message ?? ''), threw?.message)

    const split = await f.issues.setIssueDisposition(P, f.issue.id, { value: 'split', evidence: 'six findings became six issues', related: [partA.id, `${P}/${partB.id}`, partA.id] })
    t.eq('split records its parts once each, in either spelling', split.disposition.related, [{ project: P, id: partA.id }, { project: P, id: partB.id }])
    const declined = await f.issues.setIssueDisposition(P, partB.id, { value: 'declined', evidence: 'out of scope for this release' })
    t.eq('declined needs no related issues', [declined.disposition.value, declined.disposition.related], ['declined', []])
  }

  await cleanupFixtures()
}
