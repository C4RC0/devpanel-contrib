import fs from 'node:fs/promises'
import path from 'node:path'

import { issueStats } from '../server/issue-stats.mjs'
import { engineFixture } from './fakes/fixture.mjs'

export const name = 'issue statistics — per seat and model, the coordinator, and how long the issue stood'

const at = (minutes) => new Date(Date.UTC(2026, 9, 1, 8, 0) + minutes * 60000).toISOString()
const step = (role, number, from, to, extra = {}) => ({ number, role, stepId: role, attempt: 1, startedAt: at(from), endedAt: at(to), durationMs: (to - from) * 60000, usage: { tokens: 1000, costUsd: 0.5 }, ...extra })

export default async function (t) {
  t.section('1. seats are grouped by role and model, with their own working time')
  const runA = {
    runId: 'a', startedAt: at(0), endedAt: at(60), status: 'completed',
    participants: { coordinator: { model: 'opus', effort: 'medium' }, implementer: { model: 'opus', effort: 'high' }, 'auditor-1': { model: 'sol', effort: 'medium' } },
    steps: [step('coordinator', '001', 0, 2), step('implementer', '002', 2, 22), step('auditor-1', '003', 22, 30, { usage: { tokens: 500 } }), step('coordinator', '004', 30, 31),
      { number: '005', role: 'operator', stepId: 'decision', startedAt: at(31), endedAt: at(41), decision: { answer: 'yes' } }, step('coordinator', '006', 41, 42)]
  }
  const runB = {
    runId: 'b', startedAt: at(120), endedAt: at(150), status: 'completed',
    participants: { coordinator: { model: 'opus', effort: 'medium' }, implementer: { model: 'opus', effort: 'high' } },
    modelOverrides: { implementer: { model: { id: 'fable' }, effort: 'high' } },
    steps: [step('coordinator', '007', 120, 121), step('implementer', '008', 121, 141, { attempt: 2, durationMs: undefined })]
  }
  const s = issueStats([runA, runB], { issue: { openedAt: at(-60), archivedAt: at(240) } })
  t.eq('two runs', s.runs, 2)
  const seat = (role, model) => s.seats.find((x) => x.role === role && x.model === model)
  t.eq('the coordinator on one model across both runs', [seat('coordinator', 'opus')?.runs, seat('coordinator', 'opus')?.turns, seat('coordinator', 'opus')?.agentMs], [2, 4, 5 * 60000])
  t.eq('a substituted model is its own row, marked', [seat('implementer', 'fable')?.substituted, seat('implementer', 'opus')?.turns], [true, 1])
  t.eq('an untimed turn is counted, not given a time', [seat('implementer', 'fable')?.untimedTurns, seat('implementer', 'fable')?.agentMs, seat('implementer', 'fable')?.repairs], [1, 0, 1])
  t.eq('an unpriced turn is counted, not priced at zero', seat('auditor-1', 'sol')?.unpricedTurns, 1)
  t.eq('operator steps are not a seat', s.seats.some((x) => x.role === 'operator'), false)
  t.eq('the coordinator total', [s.coordinator.turns, s.coordinator.agentMs], [4, 5 * 60000])
  t.ok('busiest seat first', s.seats[0].agentMs >= s.seats.at(-1).agentMs)

  t.section('2. standing: inside runs, and with no run going')
  t.eq('elapsed is the runs\' wall clock', s.time.elapsedMs, 90 * 60000)
  t.eq('the question the run asked is time waiting on a person', s.time.operatorWaitMs, 10 * 60000)
  t.eq('standing inside runs is elapsed minus agent time', s.time.standingMs, s.time.elapsedMs - s.time.agentMs)
  t.eq('open 5 h, runs 1½ h of it: 3½ h with no run going', [s.lifetime.totalMs, s.lifetime.runningMs, s.lifetime.noRunMs], [300 * 60000, 90 * 60000, 210 * 60000])
  t.eq('usage adds up: six priced turns and one unpriced', [s.usage.tokens, s.usage.costUsd, s.usage.unpricedTurns], [6500, 3, 1])

  t.section('3. an issue without runs, or without dates, says so rather than inventing')
  const none = issueStats([], { issue: { openedAt: at(0), archivedAt: at(10) } })
  t.eq('no runs, all of its open time without one', [none.runs, none.lifetime.noRunMs], [0, 10 * 60000])
  t.eq('no archive date means no lifetime reading', issueStats([runA], { issue: { openedAt: at(0), archivedAt: null } }).lifetime, null)

  t.section('4. the run records are read for an unpacked issue too')
  const f = await engineFixture()
  const issue = await f.issues.createIssue('devpanel-project', { input: 'Stats source' })
  await fs.mkdir(path.join(issue.path, 'runs', 'r1'), { recursive: true })
  await fs.writeFile(path.join(issue.path, 'runs', 'r1', 'run.json'), JSON.stringify(runA))
  await fs.mkdir(path.join(issue.path, 'runs', 'worktree-r1'), { recursive: true })
  const records = await f.issues.readRunRecords('devpanel-project', issue.id)
  t.eq('one record, worktrees skipped', records.map((r) => r.runId), ['a'])
}
