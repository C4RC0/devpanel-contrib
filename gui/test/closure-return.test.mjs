import fs from 'node:fs/promises'
import path from 'node:path'
import { engineFixture, scriptFor } from './fakes/fixture.mjs'
import { startRun, releaseWorkspace } from '../server/runtime/launch.mjs'
import { resolvePlaybook } from '../server/config/load.mjs'
import { supportedActions } from '../server/supervisor.mjs'
import { explainRun } from '../server/runtime/run-explanation.mjs'
import { runMetrics } from '../server/runtime/run-metrics.mjs'

export const name = 'closure return — an unmet confirmation the author can still fix goes back to the review loop, at most twice'

const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```'
const revision = (p) => (p.match(/Current revision: (sha256:[a-f0-9]{64})/) ?? [])[1] ?? null
// The closure findings an audit is handed (findings.plan) and must dispose of.
const closureIds = (p) => [...new Set(p.match(/closure-AC\d+/g) ?? [])]

/*
 * An implementation run whose reviewers approve and whose check (none
 * configured: optional) never blocks; `confirm(n, prompt)` answers the n-th
 * confirmation turn, `audit(turn, ids)` may replace the auditor's answer.
 */
async function scenario ({ confirm, audit = null }) {
  const prompts = []
  const sessions = []
  let engine = null
  let confirms = 0
  const script = async (turn) => {
    const { stepId, role, round, attempt, prompt } = turn
    prompts.push({ stepId, role, round, attempt, prompt })
    if (stepId.startsWith('brief')) return fence({ targetRole: 'implementer', prompt: 'Do the work.', windowDecision: 'keep' })
    if (stepId === 'implement') {
      await fs.writeFile(path.join(engine.run.workspace.path, `round-${round}.txt`), 'work\n')
      return fence({ summary: `Implemented round ${round}`, basedOnRevision: revision(prompt) })
    }
    if (stepId.startsWith('audit-')) {
      const ids = closureIds(prompt)
      return audit?.(turn, ids) ?? fence({ verdict: 'approved', artifactRevision: revision(prompt), findings: [],
        priorFindings: ids.map((id) => ({ id, disposition: 'addressed', reason: 'fixed in this round' })) })
    }
    if (stepId === 'confirm') {
      confirms++
      sessions.push(Object.fromEntries(Object.entries(engine.run.participants).map(([r, p]) => [r, p.session?.id ?? null])))
      return fence({ revision: revision(prompt), ...confirm(confirms, prompt) })
    }
    return scriptFor()(turn)
  }
  const f = await engineFixture({ playbook: 'implementation', script })
  const runOptions = { participants: { 'auditor-1': { model: 'gpt-6-astra' } } }
  const resolved = await resolvePlaybook('implementation', { root: f.configRoot, runOptions, projectId: 'devpanel-project' })
  if (!resolved.ok) throw new Error(resolved.errors.map((e) => e.message).join('; '))
  engine = await startRun({
    expectConfigHash: resolved.resolved.configHash, playbookId: 'implementation', issue: { ...f.issue, project: 'devpanel-project' },
    issuePath: f.issuePath, projectPath: f.projectPath, harnesses: f.harnesses, stepStore: f.stepStore, workspaceProvider: f.workspaceProvider,
    configRoot: f.configRoot, probe: f.probe, clock: f.clock, deliveryProvider: f.delivery, runOptions
  })
  await engine.drive()
  return { engine, prompts, sessions }
}

const met = { satisfied: true, criteria: [{ id: 'AC1', met: true, evidence: 'audit and diff' }] }
const missingWork = { satisfied: false, criteria: [{ id: 'AC1', met: false, unmet: 'missing-work', evidence: 'a moved comment still describes the old code' }] }
const rounds = (prompts, stepId) => prompts.filter((p) => p.stepId === stepId && p.attempt === 1).map((p) => p.round)

export default async function (t) {
  t.section('missing-work on an approved, checked revision: one more author round, then closure and delivery')
  {
    const { engine, prompts, sessions } = await scenario({ confirm: (n) => n === 1 ? missingWork : met })
    const run = engine.run
    t.eq('the run completes and delivers', `${run.status} ${run.outcome} ${Boolean(run.delivery?.completedAt)}`, 'completed resolved true', `${run.blockedReason} ${JSON.stringify(run.closure?.conditions)}`)
    const back = run.steps.find((s) => s.decision?.key === 'implement-review:return')
    t.eq('a decision step by the engine, automatic', [back?.role, back?.decision?.actor, back?.decision?.automatic], ['operator', 'engine', true])
    t.eq('carrying the unmet criterion as a blocking closure finding', back?.decision?.findings?.map((f) => [f.id, f.blocking, f.criterion]), [['closure-AC1', true, 'AC1']])
    t.eq('the author got exactly one more round', rounds(prompts, 'implement'), [0, 1])
    const brief1 = prompts.find((p) => p.stepId === 'brief-implement' && p.round === 1)
    const implement1 = prompts.find((p) => p.stepId === 'implement' && p.round === 1)
    t.ok('the brief and the author see the closure finding and the coordinator\'s evidence', [brief1, implement1].every((p) => p?.prompt.includes('closure-AC1') && p.prompt.includes('a moved comment')))
    const audit1 = prompts.find((p) => p.stepId.startsWith('audit-') && p.round === 1)
    t.ok('the auditor is handed it to re-examine (findings.plan)', /### findings\.plan[\s\S]*closure-AC1/.test(audit1?.prompt ?? ''))
    t.eq('the same sessions continue after the return', sessions[1], sessions[0])
    t.eq('the confirmation was asked again; the first is superseded', [prompts.filter((p) => p.stepId === 'confirm').length, run.supersededSteps?.length], [2, 1])
    t.eq('the return is on the run record', run.closureReturns?.map((r) => [r.phase, r.criteria.map((c) => `${c.id}:${c.unmet}`)]), [['implement-review', ['AC1:missing-work']]])
    t.ok('the explanation says the run was returned once', /returned it to the author once after closure \(AC1\)/.test(explainRun(run).detail ?? ''), JSON.stringify(explainRun(run)))
    const live = explainRun({ ...run, status: 'running' })
    t.ok('while it runs, the headline and detail say why', live.headline === 'Running: returned to the author after closure' && /AC1 \(missing-work\).*return 1 of 2/.test(live.detail), JSON.stringify(live))
    const m = runMetrics(run)
    t.eq('run metrics count the return, not as an operator turn', [m.closureReturns, m.turns.automatic, m.turns.operator], [1, 1, 0])
    await releaseWorkspace(engine)
  }

  t.section('the bound: two returns, and the third unmet confirmation blocks as before')
  {
    const { engine, prompts } = await scenario({ confirm: () => missingWork })
    const run = engine.run
    t.eq('blocked at closure', `${run.status} ${run.blockedReason}`, 'blocked closure-conditions-unmet')
    t.eq('after exactly two returns', run.closureReturns?.length, 2)
    t.eq('the author had two more rounds', rounds(prompts, 'implement'), [0, 1, 2])
    t.eq('closure says why it was not returned again', run.closure?.notReturned, 'bound-reached')
    t.ok('the explanation says so', /at most twice/.test(explainRun(run).detail ?? ''), JSON.stringify(explainRun(run)))
    t.ok('the operator can still Continue', supportedActions(run).includes('continue'), JSON.stringify(supportedActions(run)))
    await releaseWorkspace(engine)
  }

  t.section('a criterion the confirmation does not classify (or does not name) blocks without a return')
  {
    const { engine, prompts } = await scenario({ confirm: () => ({ satisfied: false, criteria: [], reasoning: 'AC1 not assessed' }) })
    const run = engine.run
    t.eq('blocked at closure, no return', [`${run.status} ${run.blockedReason}`, run.closureReturns ?? []], ['blocked closure-conditions-unmet', []])
    t.eq('unclassified is named as the reason', run.closure?.notReturned, 'AC1: unclassified')
    t.eq('one author round only', rounds(prompts, 'implement'), [0])
    await releaseWorkspace(engine)
  }

  t.section('an unmet criterion without a classification is a contract violation, repaired')
  {
    const { engine, prompts } = await scenario({ confirm: (n) => n === 1
      ? { satisfied: false, criteria: [{ id: 'AC1', met: false, evidence: 'not done' }] }
      : { satisfied: false, criteria: [{ id: 'AC1', met: false, unmet: 'requirement-conflict', evidence: 'AC1 contradicts the owner note' }] } })
    const run = engine.run
    const confirms = prompts.filter((p) => p.stepId === 'confirm')
    t.eq('the confirmation was asked to restate', confirms.map((p) => p.attempt), [1, 2])
    t.ok('quoting the violation', /carry no classification/.test(confirms[1]?.prompt ?? ''))
    t.eq('a requirement conflict stays with the operator', [run.blockedReason, run.closure?.notReturned, run.closureReturns ?? []], ['closure-conditions-unmet', 'AC1: requirement-conflict', []])
    await releaseWorkspace(engine)
  }

  t.section('after a return, an audit that omits the closure finding\'s disposition is repaired')
  {
    const { engine, prompts } = await scenario({
      confirm: (n) => n === 1 ? missingWork : met,
      audit: ({ round, attempt, prompt }) => round === 1 && attempt === 1
        ? fence({ verdict: 'approved', artifactRevision: revision(prompt), findings: [], priorFindings: [] })
        : null
    })
    const audits = prompts.filter((p) => p.stepId.startsWith('audit-') && p.round === 1)
    t.eq('the round-1 audit restated once', audits.map((p) => p.attempt), [1, 2])
    t.ok('naming the missing disposition', /priorFindings must state a disposition[\s\S]*closure-AC1/.test(audits[1]?.prompt ?? ''))
    t.eq('and the run then closes', `${engine.run.status} ${engine.run.outcome}`, 'completed resolved')
    t.eq('round-0 audits, recorded before the return, were never asked about it', prompts.filter((p) => p.stepId.startsWith('audit-') && p.round === 0).map((p) => p.attempt), [1])
    await releaseWorkspace(engine)
  }
}
