import { runMetrics } from './runtime/run-metrics.mjs'

/*
 * Where an issue's time went, across all of its runs: which seat, on which
 * model, worked how long, and how long the issue stood.
 *
 * Read off the run records (run.json, or the bundle's <id>.runs.json once
 * packed); nothing is stored. Two kinds of standing are kept apart:
 *  - inside a run: waiting on a person (operatorWaitMs), stopped until resumed
 *    (suspendedMs), and engine work between turns (otherMs: checks, delivery,
 *    retry waits) — runMetrics' split, which adds up to the run's elapsed time;
 *  - between runs: from opening to archiving, the time no run was going at all.
 * Agent time is the sum of turns, asked → answered. Concurrent reviewers each
 * count their own turn, so the seats can add up to more than the time.agentMs
 * of the runs.
 */

const ms = (iso) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? t : null }

function unionMs (intervals) {
  const sorted = intervals.filter(Boolean).sort((a, b) => a.from - b.from)
  let total = 0, cur = null
  for (const i of sorted) {
    if (cur && i.from <= cur.to) cur.to = Math.max(cur.to, i.to)
    else { if (cur) total += cur.to - cur.from; cur = { ...i } }
  }
  if (cur) total += cur.to - cur.from
  return total
}

const modelOf = (run, role) => {
  const p = run.participants?.[role] ?? {}
  const override = run.modelOverrides?.[role]
  return { model: override?.model?.id ?? p.model ?? null, effort: override?.effort ?? p.effort ?? null, harness: p.harness ?? null, substituted: Boolean(override) }
}

/**
 * @param runs   run records, any order
 * @param issue  { openedAt, archivedAt } for the between-runs reading; optional
 * @param now    for runs still going
 */
export function issueStats (runs, { issue = null, now = Date.now() } = {}) {
  const records = (runs ?? []).filter((r) => r && typeof r === 'object')
  const seats = new Map()
  const totals = { elapsedMs: 0, agentMs: 0, operatorWaitMs: 0, suspendedMs: 0, otherMs: 0, unmeasuredRuns: 0 }
  const intervals = []
  let tokens = 0, costUsd = 0, unpricedTurns = 0

  for (const run of records) {
    const time = runMetrics(run, { now })?.time
    if (time?.elapsedMs == null) totals.unmeasuredRuns++
    else {
      totals.elapsedMs += time.elapsedMs
      totals.agentMs += time.agentMs
      totals.operatorWaitMs += time.operatorWaitMs
      totals.suspendedMs += time.suspendedMs
      totals.otherMs += time.otherMs ?? 0
    }
    const from = ms(run.startedAt), to = ms(run.endedAt) ?? (from != null ? now : null)
    if (from != null && to != null && to > from) intervals.push({ from, to })

    for (const step of run.steps ?? []) {
      if (step.role === 'operator') continue
      const { model, effort, harness, substituted } = modelOf(run, step.role)
      const key = `${step.role}\u0000${model}`
      if (!seats.has(key)) seats.set(key, { role: step.role, model, effort, harness, substituted, runs: new Set(), turns: 0, repairs: 0, agentMs: 0, untimedTurns: 0, tokens: 0, costUsd: 0, unpricedTurns: 0 })
      const seat = seats.get(key)
      seat.runs.add(run.runId)
      seat.turns++
      if ((step.attempt ?? 1) > 1) seat.repairs++
      if (typeof step.durationMs === 'number') seat.agentMs += step.durationMs
      else seat.untimedTurns++
      const t = Number(step.usage?.tokens)
      if (Number.isFinite(t)) { seat.tokens += t; tokens += t }
      if (typeof step.usage?.costUsd === 'number') { seat.costUsd += step.usage.costUsd; costUsd += step.usage.costUsd } else { seat.unpricedTurns++; unpricedTurns++ }
    }
  }

  const seatList = [...seats.values()]
    .map((s) => ({ ...s, runs: s.runs.size, costUsd: Math.round(s.costUsd * 1e6) / 1e6 }))
    .sort((a, b) => b.agentMs - a.agentMs)
  const coordinator = seatList.filter((s) => s.role === 'coordinator')
    .reduce((c, s) => ({ turns: c.turns + s.turns, agentMs: c.agentMs + s.agentMs }), { turns: 0, agentMs: 0 })

  // From opening to archiving (or now): how much of it no run was going.
  const opened = ms(issue?.openedAt)
  const closed = ms(issue?.archivedAt) ?? (issue?.archivedAt === undefined ? now : null)
  let lifetime = null
  if (opened != null && closed != null && closed > opened) {
    const clipped = intervals.map((i) => ({ from: Math.max(i.from, opened), to: Math.min(i.to, closed) })).filter((i) => i.to > i.from)
    const runningMs = unionMs(clipped)
    lifetime = { totalMs: closed - opened, runningMs, noRunMs: closed - opened - runningMs }
  }

  return {
    runs: records.length,
    time: { ...totals, standingMs: totals.operatorWaitMs + totals.suspendedMs + totals.otherMs },
    seats: seatList,
    coordinator,
    usage: { tokens, costUsd: Math.round(costUsd * 1e6) / 1e6, unpricedTurns },
    lifetime,
    means: 'agent time is turns asked → answered; seats sum their own turns (concurrent reviewers overlap). standingMs is time inside runs with no agent working: waiting on a person, stopped, or engine work. lifetime.noRunMs is time between opening and archiving with no run going.'
  }
}
