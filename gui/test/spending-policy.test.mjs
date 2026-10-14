import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createTopSupervisor } from '../server/top-supervisor.mjs'
import { createLedger } from '../server/runtime/ledger.mjs'
import { admits, loadPolicy, policyErrors } from '../server/runtime/spending-policy.mjs'

export const name = 'spending policy — calendar windows beside the session limits, and only once they are really there'

const temps = []
const temp = async () => { const d = await fs.mkdtemp(path.join(os.tmpdir(), 'devpanel-policy-')); temps.push(d); return d }
// Awaits the predicate: an async one returns a Promise, which is always truthy,
// and a wait that never waits is worse than no wait at all.
const wait = async (test, ms = 4000) => { const end = Date.now() + ms; while (!await test()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)) } }

const VALID = {
  version: 1,
  enforceAllowances: true,
  daily: { starts: 3, usd: 10, unpricedRuns: 2, unpricedCalls: 50 },
  monthly: { starts: 20, usd: 100, unpricedRuns: 10, unpricedCalls: 500 },
  perWakeCalls: 4, concurrent: 1
}

/** A supervisor whose model asks for one start, against a given policy file. */
async function supervisor ({ dir, policy, state = {}, maxCostUsd = null, runCost = 0.5, calls = 1, runStatus = 'completed' }) {
  if (policy !== undefined) await fs.writeFile(path.join(dir, 'spending-policy.json'), typeof policy === 'string' ? policy : JSON.stringify(policy))
  if (Object.keys(state).length) {
    // Let the supervisor write its own complete state first, then patch it —
    // seeding a hand-written file would be a guess at a shape this test does not
    // own, and a wrong guess reads as a policy failure.
    const seed = await createTopSupervisor({ dir, models: async () => [], adapter: { invoke: async () => ({}) }, tools: { projects: async () => [], playbooks: async () => [], listIssues: async () => [] }, pollMs: 1000 })
    await seed.shutdown()
    const file = path.join(dir, 'state.json')
    const existing = await fs.readFile(file, 'utf8').then(JSON.parse).catch(() => ({}))
    await fs.writeFile(file, JSON.stringify({ ...existing, ...state }))
  }
  const starts = []
  const runs = new Map()
  let turn = 0
  const script = []
  for (let n = 0; n < calls; n++) {
    script.push(() => ({ type: 'preview', project: 'p-project', issueId: 'issue', playbook: 'test' }))
    script.push((e) => ({ type: 'start_run', project: 'p-project', issueId: 'issue', previewId: e.result.previewId }))
  }
  const adapter = {
    invoke: async (args) => {
      const event = JSON.parse(args.prompt).event
      // A new native session (after New session) replays the script from the top.
      if (!args.session) turn = 0
      return { session: args.session ?? { id: 's' }, response: JSON.stringify({ message: 'ok', action: script[turn++]?.(event) ?? null }), usage: { costUsd: 0.01 } }
    }
  }
  const tools = {
    projects: async () => [{ id: 'p-project' }], playbooks: async () => [], listIssues: async () => [{ id: 'issue' }],
    getIssue: async () => ({ name: 'issue' }), infrastructure: async () => ({}),
    preview: async () => ({ ok: true, configHash: 'hash', limits: { budgets: { maxCostUsd } } }),
    start: async (p) => { starts.push(p); const r = { runId: 'r' + starts.length, status: runStatus }; runs.set(r.runId, r); return r },
    getRun: async (_p, _i, id) => ({ ...runs.get(id), budgets: { used: { costUsd: runCost } } }),
    stop: async () => ({}), addNote: async () => ({})
  }
  const agent = await createTopSupervisor({ dir, models: async () => [{ id: 'm', title: 'M', model: 'm', verification: { status: 'verified' } }], adapter, tools, pollMs: 20 })
  return { agent, starts, runs, tools }
}

export default async function (t) {
  t.section('1. a policy is only a policy once every ceiling is there and consistent')
  {
    t.eq('a complete policy validates', policyErrors(VALID), [])
    for (const [label, broken] of [
      ['a missing daily window', { ...VALID, daily: undefined }],
      ['a zero ceiling', { ...VALID, daily: { ...VALID.daily, starts: 0 } }],
      ['a fractional count', { ...VALID, perWakeCalls: 2.5 }],
      ['a negative currency ceiling', { ...VALID, monthly: { ...VALID.monthly, usd: -1 } }],
      ['a daily ceiling above the monthly one', { ...VALID, daily: { ...VALID.daily, starts: 999 } }],
      ['a version nobody wrote', { ...VALID, version: 2 }],
      ['a timezone with no implementation', { ...VALID, timezone: 'Europe/Budapest' }],
      ['no unpriced run allowance', { ...VALID, daily: { starts: 1, usd: 1, unpricedCalls: 1 } }],
      ['no unpriced call allowance', { ...VALID, daily: { starts: 1, usd: 1, unpricedRuns: 1 } }]
    ]) t.ok(`${label} is refused, with a reason`, policyErrors(broken).length > 0, JSON.stringify(policyErrors(broken)))

    const dir = await temp()
    t.ok('an absent file is not an active policy', !(await loadPolicy(path.join(dir, 'nope.json'))).active)
    t.ok('and says so plainly', /no spending policy is configured/.test((await loadPolicy(path.join(dir, 'nope.json'))).reason))
    await fs.writeFile(path.join(dir, 'broken.json'), '{ not json')
    const broken = await loadPolicy(path.join(dir, 'broken.json'))
    t.ok('unparseable is not an active policy either', !broken.active && /not valid JSON/.test(broken.reason), broken.reason)
    await fs.writeFile(path.join(dir, 'invalid.json'), JSON.stringify({ ...VALID, perWakeCalls: 0 }))
    const invalid = await loadPolicy(path.join(dir, 'invalid.json'))
    t.ok('invalid names what was wrong', !invalid.active && /perWakeCalls/.test(invalid.reason), invalid.reason)
    await fs.writeFile(path.join(dir, 'good.json'), JSON.stringify(VALID))
    t.eq('and a valid one, reloaded from disk, is active', (await loadPolicy(path.join(dir, 'good.json'))).active, true)
  }

  t.section('2. admission counts committed money, not spent money')
  {
    const w = (o = {}) => ({ starts: 0, unpricedRuns: 0, unpricedCalls: 0, committedUsdMicros: 0, committedUsd: 0, overageUsdMicros: 0, overageUsd: 0, ...o })
    const micros = (usd) => ({ committedUsdMicros: Math.round(usd * 1e6), committedUsd: usd })
    const usage = (day) => ({ day: w(day), month: w() })
    t.eq('room left admits', admits({ policy: VALID, usage: usage(micros(4)), subject: 'run-start', maxCostUsd: 5 }).ok, true)
    const over = admits({ policy: VALID, usage: usage(micros(8)), subject: 'run-start', maxCostUsd: 5 })
    t.eq('a reservation that would exceed the day is refused', [over.ok, over.limit], [false, 'daily.usd'])
    t.ok('naming when it may be tried again', /next UTC day/.test(over.until), over.until)

    // An overage is already inside committedUsd; the window closes by itself.
    const spent = admits({ policy: VALID, usage: usage({ ...micros(12), overageUsdMicros: 4_000_000, overageUsd: 4 }), subject: 'run-start', maxCostUsd: 0.5 })
    t.eq('a window pushed past its ceiling by an overage admits nothing', spent.ok, false)
    t.ok('and says the overspend is part of why', /spent beyond what was reserved/.test(spent.detail), spent.detail)

    const unpriced = admits({ policy: VALID, usage: usage({ unpricedRuns: 2 }), subject: 'run-start', maxCostUsd: null })
    t.eq('an unpriced run draws on its own allowance', [unpriced.ok, unpriced.limit], [false, 'daily.unpricedRuns'])
    t.ok('pointing at the fix', /maxCostUsd budget/.test(unpriced.detail), unpriced.detail)
    t.eq('while money it cannot price does not block a priced run', admits({ policy: VALID, usage: usage({ unpricedRuns: 2 }), subject: 'run-start', maxCostUsd: 1 }).ok, true)
    // The conflation this separates: unpriced CALLS used to consume the run
    // allowance, blocking runs while being unbounded themselves.
    t.eq('exhausted calls do not block a run', admits({ policy: VALID, usage: usage({ unpricedCalls: 50 }), subject: 'run-start', maxCostUsd: null }).ok, true)
    t.eq('exhausted runs do not block a call', admits({ policy: VALID, usage: usage({ unpricedRuns: 2 }), subject: 'model-call' }).ok, true)
    const callsOut = admits({ policy: VALID, usage: usage({ unpricedCalls: 50 }), subject: 'model-call' })
    t.eq('and calls are bounded by their own allowance', [callsOut.ok, callsOut.limit], [false, 'daily.unpricedCalls'])

    const wake = admits({ policy: VALID, usage: usage({}), subject: 'model-call', wakeCalls: 4 })
    t.eq('a wake that has used its calls is refused', [wake.ok, wake.limit], [false, 'perWakeCalls'])
    {
      // Retries per issue are a session limit, not calendar spending. An older
      // policy that still carries the key loads, and says the key is ignored.
      const dir = await temp()
      await fs.writeFile(path.join(dir, 'spending-policy.json'), JSON.stringify({ ...VALID, perIssueStarts: 2 }))
      const legacy = await loadPolicy(path.join(dir, 'spending-policy.json'))
      t.eq('a policy with perIssueStarts still activates', legacy.active, true)
      t.ok('and reports the key as ignored, naming the session limit instead', /perIssueStarts is ignored.*maxStartsPerIssue/.test(legacy.ignored?.[0] ?? ''), JSON.stringify(legacy.ignored))
    }
    t.eq('and so is concurrency', admits({ policy: VALID, usage: usage({}), subject: 'run-start', maxCostUsd: 1, concurrent: 1 }).limit, 'concurrent')
  }

  t.section('2b. an unpriced allowance is permission to risk money, not to ignore that it is gone')
  {
    // The bypass this closes: an unpriced subject used to check only its own
    // allowance and skip the money check entirely, so once the window was known
    // to be spent, unpriced work carried on regardless.
    const file = path.join(await temp(), 'ledger.jsonl')
    const ledger = createLedger({ file })
    await ledger.load()
    const now = Date.parse('2026-09-15T12:00:00Z')

    // A call nobody could price in advance turns out to have cost more than the
    // whole daily allowance. This is exactly the risk the allowance exists for —
    // and exactly the knowledge that must now bind.
    await ledger.reserve({ id: 'expensive-call', subject: 'model-call', at: now })
    await ledger.settle({ id: 'expensive-call', costUsd: 12, at: now })
    const usage = ledger.usage(now)
    t.eq('the settled cost is above the $10 daily ceiling', usage.day.settledUsdMicros, 12_000_000)
    t.ok('with allowances left on paper', usage.day.unpricedCalls < VALID.daily.unpricedCalls && usage.day.unpricedRuns < VALID.daily.unpricedRuns, JSON.stringify(usage.day))

    for (const [label, subject, maxCostUsd] of [
      ['another unpriced call', 'model-call', null],
      ['an unpriced run', 'run-start', null],
      ['a priced run', 'run-start', 1]
    ]) {
      const verdict = admits({ policy: VALID, usage, subject, maxCostUsd })
      t.eq(`${label} is refused by the money, not by its own allowance`, [verdict.ok, verdict.limit], [false, 'daily.usd'])
      t.ok('saying the allowance is spent', /is spent/.test(verdict.detail), verdict.detail)
    }

    // Below the ceiling the allowance still does its job: risk is permitted.
    const room = createLedger({ file: path.join(await temp(), 'ledger.jsonl') })
    await room.load()
    await room.reserve({ id: 'cheap', subject: 'model-call', at: now })
    await room.settle({ id: 'cheap', costUsd: 1, at: now })
    t.eq('with money left, an unpriced call is admitted', admits({ policy: VALID, usage: room.usage(now), subject: 'model-call' }).ok, true)
    t.eq('and so is an unpriced run', admits({ policy: VALID, usage: room.usage(now), subject: 'run-start', maxCostUsd: null }).ok, true)

    // The boundary itself: committed exactly equal to the ceiling is spent.
    const exact = createLedger({ file: path.join(await temp(), 'ledger.jsonl') })
    await exact.load()
    await exact.reserve({ id: 'all-of-it', subject: 'run-start', at: now, maxCostUsd: 10 })
    t.eq('committed exactly at the ceiling admits nothing further', admits({ policy: VALID, usage: exact.usage(now), subject: 'model-call' }).limit, 'daily.usd')
  }

  t.section('2c. the running service answers "which gate is in force" from outside the process')
  {
    // It was unanswerable: the file could be valid while the service that read it
    // started before the file existed, and nothing reported the difference.
    const dir = await temp()
    const { agent } = await supervisor({ dir, policy: VALID })
    try {
      const view = agent.get()
      t.eq('the view says the policy is active', view.spending.active, true)
      t.eq('and what decides because of it', view.spending.decides, 'session limits, then daily and monthly windows')
      t.eq('with the ceilings it actually loaded', view.spending.policy.daily.starts, VALID.daily.starts)
      t.ok('and the ledger it is counting against', /ledger\.jsonl$/.test(view.spending.ledger.file), view.spending.ledger.file)
      t.ok('including the windows as they stand', view.spending.ledger.usage?.windows?.day?.length === 10, JSON.stringify(view.spending.ledger.usage?.windows))
    } finally { await agent.stop().catch(() => {}); await agent.shutdown().catch(() => {}) }

    const bare = await temp()
    const { agent: unset } = await supervisor({ dir: bare })
    try {
      const view = unset.get()
      t.eq('with no policy it says so', view.spending.active, false)
      t.eq('naming what still gates', view.spending.decides, 'session limits only')
      t.ok('and why', /no spending policy is configured/.test(view.spending.reason), view.spending.reason)
      t.eq('claiming no ceilings it does not have', view.spending.policy, null)
    } finally { await unset.stop().catch(() => {}); await unset.shutdown().catch(() => {}) }

    const broken = await temp()
    const { agent: invalid } = await supervisor({ dir: broken, policy: { ...VALID, perWakeCalls: 0 } })
    try {
      t.eq('an invalid policy is reported as not active', invalid.get().spending.active, false)
      t.ok('with the validation error verbatim', /perWakeCalls/.test(invalid.get().spending.reason), invalid.get().spending.reason)
    } finally { await invalid.stop().catch(() => {}); await invalid.shutdown().catch(() => {}) }
  }

  t.section('3. without a valid policy, the session limits are the only gate, and they say so')
  {
    const spent = { starts: 8, limits: { maxCalls: 50, maxRuns: 2, maxConcurrent: 1, maxStartsPerIssue: 2 } }

    for (const [label, policy] of [['no policy at all', undefined], ['an invalid policy', { ...VALID, perWakeCalls: 0 }]]) {
      const dir = await temp()
      const { agent, starts } = await supervisor({ dir, policy, state: spent })
      try {
        await agent.start({ model: 'm', projects: ['p-project'], message: 'start it', limits: spent.limits })
        await wait(() => agent.get().messages.some((m) => m.role === 'tool' && /Session run-start limit reached/.test(m.text)))
        t.eq(`with ${label}, the session limit refuses`, starts.length, 0)
        const told = agent.get().messages.filter((m) => m.role === 'tool').map((m) => m.text).join('\n')
        t.ok('and names New session as the operator\'s way out', /New session/.test(told), told.slice(-200))
        t.eq('and the view says nothing else gates', agent.get().spending.decides, 'session limits only')
      } finally { await agent.stop().catch(() => {}); await agent.shutdown().catch(() => {}) }
    }
  }

  t.section('4. a valid policy adds the windows beside the session limits; New session renews the session, not the windows')
  {
    const dir = await temp()
    // A session that has used 8 starts against a cap of 2: the policy does not
    // demote that limit, so it still refuses.
    const spent = { starts: 8, limits: { maxCalls: 50, maxRuns: 2, maxConcurrent: 1, maxStartsPerIssue: 2 } }
    const { agent, starts } = await supervisor({ dir, policy: VALID, state: spent, maxCostUsd: 2 })
    try {
      await agent.start({ model: 'm', projects: ['p-project'], message: 'start it', limits: spent.limits })
      await wait(() => agent.get().messages.some((m) => m.role === 'tool' && /Session run-start limit reached/.test(m.text)))
      t.eq('the session limit refuses even with the policy active', starts.length, 0)
      await agent.stop()
      await agent.reset()
      t.eq('New session begins a fresh session allowance', agent.get().starts, 0)
      t.eq('and keeps what was used as history', agent.get().history.starts, 8)
      await agent.start({ model: 'm', projects: ['p-project'], message: 'start it', limits: spent.limits })
      await wait(() => starts.length === 1)
      t.eq('the fresh session starts', starts.length, 1)
      t.eq('and the session counts it', agent.get().starts, 1)
      t.ok('and the policy was read from disk, not assumed', (await loadPolicy(path.join(dir, 'spending-policy.json'))).active)

      const ledger = createLedger({ file: path.join(dir, 'ledger.jsonl') })
      await ledger.load()
      const usage = ledger.usage()
      t.eq('the start reserved its configured ceiling', usage.day.starts, 1)
      t.ok('committing that money before it was spent', usage.day.committedUsd >= 2, JSON.stringify(usage.day))
      t.ok('and the supervisor\'s own calls are counted too', usage.day.modelCalls > 0, JSON.stringify(usage.day))
    } finally { await agent.stop().catch(() => {}); await agent.shutdown().catch(() => {}) }
  }

  t.section('5. with the policy active, the window refuses and says when it may be retried')
  {
    const dir = await temp()
    // Concurrency must not be the binding limit here, or this tests the wrong refusal.
    const tight = { ...VALID, daily: { ...VALID.daily, starts: 1 }, concurrent: 3 }
    const { agent, starts } = await supervisor({ dir, policy: tight, state: { limits: { maxCalls: 50, maxRuns: 99, maxConcurrent: 2, maxStartsPerIssue: 9 } }, maxCostUsd: 1, calls: 2 })
    try {
      await agent.start({ model: 'm', projects: ['p-project'], message: 'start two', limits: { maxCalls: 50, maxRuns: 99, maxConcurrent: 2, maxStartsPerIssue: 9 } })
      await wait(() => agent.get().messages.some((m) => m.role === 'tool' && /daily.starts/.test(m.text)))
      t.eq('the first start is admitted', starts.length, 1)
      const told = agent.get().messages.filter((m) => m.role === 'tool').map((m) => m.text).join('\n')
      t.ok('the second is refused by the day, not by a lifetime cap', /Refused by daily.starts/.test(told), told.slice(-250))
      t.ok('and says when it may be tried again', /next UTC day/.test(told), told.slice(-250))
    } finally { await agent.stop().catch(() => {}); await agent.shutdown().catch(() => {}) }
  }

  t.section('6. settlement replaces the reservation with what the run really cost')
  {
    const dir = await temp()
    const { agent, runs } = await supervisor({ dir, policy: VALID, state: { limits: { maxCalls: 50, maxRuns: 99, maxConcurrent: 1, maxStartsPerIssue: 9 } }, maxCostUsd: 5, runCost: 1.25, runStatus: 'running' })
    try {
      await agent.start({ model: 'm', projects: ['p-project'], message: 'start it', limits: { maxCalls: 50, maxRuns: 99, maxConcurrent: 1, maxStartsPerIssue: 9 } })
      await wait(() => runs.size === 1)
      const ledger = createLedger({ file: path.join(dir, 'ledger.jsonl') })
      await ledger.load()
      t.ok('while the run is live the window holds the reservation', ledger.usage().day.committedUsd >= 5, JSON.stringify(ledger.usage().day))

      runs.get('r1').status = 'completed'
      await wait(async () => { const l = createLedger({ file: path.join(dir, 'ledger.jsonl') }); await l.load(); return l.outstanding().every((r) => r.subject !== 'run-start') }, 6000)
      const after = createLedger({ file: path.join(dir, 'ledger.jsonl') })
      await after.load()
      const runStarts = [...after.outstanding()].filter((r) => r.subject === 'run-start')
      t.eq('once it ends, the reservation is settled', runStarts.length, 0)
      t.ok('and the window holds what it cost, not what it reserved', after.usage().day.settledUsd < 5, JSON.stringify(after.usage().day))
    } finally { await agent.stop().catch(() => {}); await agent.shutdown().catch(() => {}) }
  }

  for (const dir of temps) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
}
