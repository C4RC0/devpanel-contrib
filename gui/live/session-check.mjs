/*
 * The two-invocation live session check, as a function.
 *
 * Extracted from the CLI so it can be exercised against a shim before anyone
 * spends money on it — the first paid run should not be the first time this code
 * executes.
 *
 * A separate deep probe is deliberately NOT part of this. Two successful turns
 * already demonstrate that credentials work and that the model is reachable;
 * paying again to establish the same facts would be waste.
 */

const NL = String.fromCharCode(10)

/**
 * Every invocation is recorded as an ATTEMPT before its outcome is known, so a
 * failure cannot vanish from the accounting. A failed call may still have been
 * billed, which is why its cost is recorded as unknown rather than zero.
 */
export function createLedger () {
  return {
    invocations: [],
    costUsd: 0,
    costUnknownCalls: 0,
    tokens: 0,
    record (entry) {
      this.invocations.push(entry)
      if (entry.outcome === 'completed' && typeof entry.usage?.costUsd === 'number' && Number.isFinite(entry.usage.costUsd)) {
        this.costUsd += entry.usage.costUsd
      } else {
        this.costUnknownCalls += 1
      }
      this.tokens += entry.usage?.tokens ?? 0
    },
    summary () {
      return this.costUnknownCalls
        ? `at least $${this.costUsd.toFixed(4)} (${this.costUnknownCalls} call(s) reported no cost)`
        : `$${this.costUsd.toFixed(4)}`
    }
  }
}

const WORD = 'ALPHA'

/**
 * Effort evidence for one turn, in three separate claims, because a completed
 * turn alone proves none of them about the effort:
 *
 *   forwarded  the adapter was handed the effort (the offline contract test is
 *              what proves it reaches the argv; here it is what was asked for)
 *   accepted   the runtime completed the turn with that effort on its command
 *              line — the provider took the request
 *   recorded   what the runtime's own session record says it sent for THIS turn,
 *              read off the filesystem by `adapter.inspectSession`, never off the
 *              model's answer; the model named on the same line must be the one
 *              requested, or the turn is not the one under test
 *
 * `matchesRequest` is recorded === requested. That is the LIMIT of what this
 * establishes: the CLI sent the requested setting and the provider completed
 * the turn. How the backend interpreted the setting is not observed here.
 * Without a session record the turn is inconclusive: accepted, but nothing
 * shows what was sent.
 */
async function effortEvidence ({ adapter, session, requested, model, expectedTurns }) {
  const evidence = { requested, model: { requested: model ?? null, recorded: null }, forwarded: true, accepted: true, recorded: null, matchesRequest: null, turns: null, source: null }
  if (typeof adapter.inspectSession !== 'function') {
    return { ...evidence, status: 'inconclusive', detail: `${adapter.id ?? 'the adapter'} exposes no session record to read the effort back from` }
  }
  const record = await adapter.inspectSession({ session }).catch(() => null)
  if (!record) return { ...evidence, status: 'inconclusive', detail: 'no session record names this session, so the effort sent cannot be read back' }
  evidence.source = record.file ?? null
  evidence.turns = record.turns.length
  const turn = record.turns.at(-1) ?? null
  if (record.turns.length !== expectedTurns || !turn) {
    return { ...evidence, status: 'inconclusive', detail: `the session record holds ${record.turns.length} turn(s) where ${expectedTurns} were expected, so the turn cannot be attributed` }
  }
  evidence.recorded = turn.effort ?? null
  evidence.model.recorded = turn.model ?? null
  if (model && evidence.model.recorded !== model) {
    return { ...evidence, matchesRequest: false, status: 'fail', detail: `the session record names model ${JSON.stringify(evidence.model.recorded)} for this turn, not "${model}", so its effort is not evidence about the model under test` }
  }
  evidence.matchesRequest = evidence.recorded === requested
  return {
    ...evidence,
    status: evidence.matchesRequest ? 'pass' : 'fail',
    detail: evidence.matchesRequest
      ? `the runtime recorded effort "${evidence.recorded}" for this turn`
      : `the runtime recorded effort ${JSON.stringify(evidence.recorded)} for this turn, not "${requested}"`
  }
}

/**
 * @param adapter       the harness adapter under test
 * @param effort        optional: run the turns at this effort and read back, per
 *                      turn, what the runtime recorded it sent (see effortEvidence)
 * @param resumeEffort  optional, with `effort`: request THIS level on the resumed
 *                      turn instead. Two equal requests cannot tell an honoured
 *                      override from an inherited one; a different level can.
 * @param reserve       () => void — throws when a cap would be exceeded; called BEFORE each call
 * @param log           optional progress reporter
 */
export async function runSessionCheck ({
  adapter,
  harnessId,
  model,
  effort = null,
  resumeEffort = null,
  workspace,
  ledgerDir,
  reserve = () => {},
  log = () => {},
  ledger = createLedger()
} = {}) {
  if (resumeEffort && !effort) throw new Error('resumeEffort needs an effort for the first turn')
  const result = {
    harness: harnessId,
    model,
    effort,
    resumeEffort: effort ? (resumeEffort ?? effort) : null,
    cliVersion: null,
    sessionAssignment: adapter.capabilities?.sessionAssignment ?? null,
    stages: [],
    sessions: { first: null, resumed: null, continuous: null },
    responses: { first: null, resumed: null },
    remembered: null,
    // Derived from the turns themselves rather than from a separate paid probe.
    demonstrated: { authentication: 'unknown', modelAccess: 'unknown' },
    // Per turn, when an effort was requested; null otherwise.
    effortEvidence: effort ? { first: null, resumed: null } : null,
    ledger
  }

  const stage = (name, status, detail = {}) => {
    result.stages.push({ name, status, ...detail })
    log(name, status, detail)
    return status
  }

  // ---------------------------------------------------------------- free
  const probed = await adapter.probe({ depth: 'installation' })
  result.cliVersion = probed.installation.version
  if (probed.installation.status !== 'installed') {
    stage('installation', 'fail', { detail: probed.installation.detail })
    return result
  }
  stage('installation', 'pass', { version: probed.installation.version })

  // ---------------------------------------------------------------- turn 1
  const marker1 = `devpanel:live:${Date.now()}:1`
  let first
  try {
    reserve()
    first = await adapter.invoke({
      model,
      effort,
      cwd: workspace,
      ledgerDir,
      prompt: `Reply with exactly: ${WORD}. Nothing else.`,
      marker: marker1,
      meta: { invocationId: 'live-1', role: 'live' }
    })
    ledger.record({ stage: 'first', effort, outcome: 'completed', session: first.session?.id ?? null, usage: first.usage, marker: marker1 })
  } catch (error) {
    // A refused reservation means no call was made, so it is not an attempt.
    if (!/invocation cap|stop threshold/.test(error.message)) {
      ledger.record({
        stage: 'first',
        effort,
        outcome: 'failed',
        error: error.message,
        // The runtime's own diagnostic is the part worth keeping; the exit code
        // alone ("claude exited 3") says nothing about why.
        detail: error.stderr ?? error.detail ?? null,
        kind: error.kind ?? error.name,
        usage: null,
        marker: marker1
      })
    }
    stage('first-turn', 'fail', { detail: [error.message, error.stderr].filter(Boolean).join(' — ') })
    return result
  }

  result.sessions.first = first.session?.id ?? null
  result.responses.first = first.response
  stage('first-turn', first.session?.id ? 'pass' : 'fail', { session: result.sessions.first, usage: first.usage })

  // Two successful turns are the demonstration; nothing else needs paying for.
  result.demonstrated = { authentication: 'ok', modelAccess: 'ok' }

  if (effort) {
    const evidence = await effortEvidence({ adapter, session: first.session, requested: effort, model, expectedTurns: 1 })
    result.effortEvidence.first = evidence
    stage('effort-first', evidence.status, { detail: evidence.detail })
  }

  // ---------------------------------------------------------------- turn 2
  const marker2 = `devpanel:live:${Date.now()}:2`
  let second
  try {
    reserve()
    second = await adapter.invoke({
      session: first.session,
      model,
      effort: result.resumeEffort,
      cwd: workspace,
      ledgerDir,
      prompt: 'What single word did you just reply? Answer with that word only.',
      marker: marker2,
      meta: { invocationId: 'live-2', role: 'live' }
    })
    ledger.record({ stage: 'resume', effort: result.resumeEffort, outcome: 'completed', session: second.session?.id ?? null, usage: second.usage, marker: marker2 })
  } catch (error) {
    if (!/invocation cap|stop threshold/.test(error.message)) {
      ledger.record({
        stage: 'resume',
        effort: result.resumeEffort,
        outcome: 'failed',
        error: error.message,
        detail: error.stderr ?? error.detail ?? null,
        kind: error.kind ?? error.name,
        usage: null,
        marker: marker2
      })
    }
    stage('resume', 'fail', { detail: [error.message, error.stderr].filter(Boolean).join(' — ') })
    return result
  }

  result.sessions.resumed = second.session?.id ?? null
  result.responses.resumed = second.response
  result.sessions.continuous = Boolean(result.sessions.first) && result.sessions.first === result.sessions.resumed
  result.remembered = new RegExp(WORD, 'i').test(second.response ?? '')

  stage('resume', result.sessions.continuous ? 'pass' : 'fail', {
    session: result.sessions.resumed, usage: second.usage
  })
  stage('continuity', result.remembered ? 'pass' : 'fail', {
    detail: result.remembered
      ? `the resumed session recalled "${WORD}"`
      : `the resumed session did not recall "${WORD}" — the id carried over but the conversation may not have`
  })

  if (effort) {
    // `exec resume` takes the override again. With the same level on both turns
    // this shows the level continued; only a DIFFERENT resumeEffort can show the
    // override on resume was honoured rather than inherited.
    const evidence = await effortEvidence({ adapter, session: second.session, requested: result.resumeEffort, model, expectedTurns: 2 })
    result.effortEvidence.resumed = evidence
    stage('effort-resumed', evidence.status, { detail: evidence.detail })
  }

  return result
}

const bothTurnsAsRequested = (result) =>
  passed(result) && ['first', 'resumed'].every((turn) => result.effortEvidence?.[turn]?.status === 'pass')

/**
 * The LEVEL verdict: the whole session check passed (both turns, one continuous
 * session that remembered) AND both turns were requested at that level AND both
 * records name it for the requested model. This is what a roster entry may
 * list. A run that switched levels on resume tested the level on ONE turn only,
 * so it never verifies the level — see effortSwitchVerified. A level "verified"
 * on a session that broke is not evidence about the level.
 */
export const effortVerified = (result) =>
  Boolean(result.effort) && result.resumeEffort === result.effort && bothTurnsAsRequested(result)

/**
 * The SWITCH verdict: fresh at one level, resumed at another, both recorded as
 * requested. It shows the override on resume is honoured rather than inherited.
 * It says nothing about either level on its own, so it goes nowhere near the roster.
 */
export const effortSwitchVerified = (result) =>
  Boolean(result.effort) && Boolean(result.resumeEffort) && result.resumeEffort !== result.effort && bothTurnsAsRequested(result)

export const passed = (result) =>
  result.stages.length > 0 && result.stages.every((s) => s.status === 'pass')

export const describe = (result) => [
  `harness ${result.harness} (${result.cliVersion ?? 'unknown version'})`,
  `session assignment ${result.sessionAssignment}`,
  `sessions ${result.sessions.first ?? '—'} -> ${result.sessions.resumed ?? '—'}`,
  `continuous ${result.sessions.continuous}`,
  `remembered ${result.remembered}`,
  ...(result.effort
    ? [`effort requested ${result.effort}${result.resumeEffort !== result.effort ? ` then ${result.resumeEffort} on resume` : ''}; recorded by the runtime: fresh ${result.effortEvidence?.first?.recorded ?? '—'}, resumed ${result.effortEvidence?.resumed?.recorded ?? '—'} (${result.resumeEffort !== result.effort ? `switch ${effortSwitchVerified(result) ? 'verified' : 'NOT verified'}; neither level verified on its own` : `level ${effortVerified(result) ? 'verified' : 'NOT verified'}`})`]
    : []),
  `spent ${result.ledger.summary()} over ${result.ledger.invocations.length} attempt(s)`
].join(NL)
