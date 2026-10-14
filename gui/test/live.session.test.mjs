import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createLedger, runSessionCheck, passed, effortVerified, effortSwitchVerified, describe as describeText } from '../live/session-check.mjs'

export const name = 'live session check — exercised against shims, before anything is paid for'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const AGENT = path.join(HERE, 'fakes/cli/agent.mjs')
const NL = String.fromCharCode(10)

const temps = []
async function temp () {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'live-'))
  temps.push(d)
  return d
}

/**
 * Point a real adapter at a controlled subprocess. `recall` makes the second turn
 * echo ALPHA, standing in for a runtime that genuinely remembered.
 */
async function harness (which, { mode = 'ok', recall = true, version = 'shim 1.0.0', rollout = false } = {}) {
  const file = path.join(await temp(), 'cli')
  await fs.writeFile(file, [
    '#!/bin/sh',
    `export AGENT_MODE='${mode}'`,
    `export AGENT_SHAPE='${which}'`,
    `export AGENT_VERSION='${version}'`,
    recall ? "export AGENT_RECALL='ALPHA'" : '',
    // The codex shape keeps a session record under CODEX_HOME, as the real CLI does.
    rollout ? "export AGENT_ROLLOUT='1'" : '',
    `exec "${process.execPath}" "${AGENT}" "$@"`
  ].join(NL) + NL)
  await fs.chmod(file, 0o755)
  process.env[which === 'claude' ? 'DEVPANEL_CLAUDE_BIN' : 'DEVPANEL_CODEX_BIN'] = file
  return import(`../../harness/${which}.mjs`)
}

const run = async (which, options = {}, { maxInvocations = 2, effort = null, resumeEffort = null } = {}) => {
  const adapter = await harness(which, options)
  const ledger = createLedger()
  const reserve = () => {
    if (ledger.invocations.length >= maxInvocations) throw new Error(`invocation cap reached (${maxInvocations})`)
  }
  return runSessionCheck({
    adapter,
    harnessId: which,
    model: which === 'claude' ? 'claude-haiku-4-5' : 'gpt-6-astra',
    effort,
    resumeEffort,
    workspace: await temp(),
    ledgerDir: await temp(),
    ledger,
    reserve
  })
}

const stageNamed = (r, name) => r.stages.find((s) => s.name === name)

export default async function (t) {
  t.section('Claude: two turns, one session, everything recorded')
  {
    const r = await run('claude')
    t.ok('the check passes', passed(r), r.stages.filter((s) => s.status !== 'pass').map((s) => s.name).join(','))
    t.eq('exactly two invocations', r.ledger.invocations.length, 2)
    t.eq('the observed CLI version is recorded', r.cliVersion, 'shim 1.0.0')
    t.eq('session assignment recorded', r.sessionAssignment, 'preassign')

    t.ok('a session id was captured', Boolean(r.sessions.first))
    t.eq('the second turn resumed it', r.sessions.resumed, r.sessions.first)
    t.eq('continuity recorded', r.sessions.continuous, true)
    t.ok('the runtime recalled the word', r.remembered, JSON.stringify(r.responses.resumed?.slice(0, 40)))

    t.ok('both responses recorded', Boolean(r.responses.first) && Boolean(r.responses.resumed))
    t.eq('usage accumulated, cache included', r.ledger.tokens, 4366)
    t.ok('cost accumulated', r.ledger.costUsd > 0, r.ledger.summary())
    t.eq('nothing unpriced', r.ledger.costUnknownCalls, 0)

    t.eq('authentication is demonstrated by the turns', r.demonstrated.authentication, 'ok')
    t.eq('model access likewise', r.demonstrated.modelAccess, 'ok')
    t.ok('no separate paid probe ran — only two invocations total', r.ledger.invocations.length === 2)
  }

  t.section('Codex: the same check, through a discovered session')
  {
    const r = await run('codex')
    t.ok('the check passes', passed(r), r.stages.filter((s) => s.status !== 'pass').map((s) => `${s.name}:${s.detail ?? ''}`).join(','))
    t.eq('session assignment recorded', r.sessionAssignment, 'discover')
    t.ok('a session id was discovered', Boolean(r.sessions.first))
    t.eq('and resumed', r.sessions.resumed, r.sessions.first)
    t.eq('continuity recorded', r.sessions.continuous, true)
    t.eq('the CLI version is recorded', r.cliVersion, 'shim 1.0.0')

    t.eq('usage tokens captured', r.ledger.tokens, 66)
    t.eq('but cost is UNKNOWN, not zero', r.ledger.costUnknownCalls, 2)
    t.ok('and the summary says so', /reported no cost/.test(r.ledger.summary()), r.ledger.summary())
  }

  t.section('Codex: an effort is verified per turn off the runtime\'s own record, never off the answer')
  {
    process.env.CODEX_HOME = await temp()
    const r = await run('codex', { rollout: true }, { effort: 'xhigh' })
    t.ok('the check passes', passed(r), r.stages.filter((s) => s.status !== 'pass').map((s) => `${s.name}:${s.detail ?? ''}`).join(','))
    t.eq('still exactly two invocations — evidence is read, not bought', r.ledger.invocations.length, 2)
    t.eq('the effort under test is recorded', r.effort, 'xhigh')
    t.ok('the level is verified', effortVerified(r))
    t.eq('a stage per turn, both passing', [stageNamed(r, 'effort-first')?.status, stageNamed(r, 'effort-resumed')?.status], ['pass', 'pass'])

    const { first, resumed } = r.effortEvidence
    t.eq('fresh turn: forwarded, accepted, recorded as requested', [first.forwarded, first.accepted, first.recorded, first.matchesRequest], [true, true, 'xhigh', true])
    t.eq('resumed turn likewise', [resumed.forwarded, resumed.accepted, resumed.recorded, resumed.matchesRequest], [true, true, 'xhigh', true])
    t.eq('the record names the model under test, and that was checked', [first.model.requested, first.model.recorded], ['gpt-6-astra', 'gpt-6-astra'])
    t.eq('with no resume effort given, the resumed turn asked for the same level', r.resumeEffort, 'xhigh')
    t.eq('the record grew by one turn per invocation', [first.turns, resumed.turns], [1, 2])
    t.ok('the evidence names the runtime\'s own file under CODEX_HOME', first.source?.startsWith(process.env.CODEX_HOME) && /sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-.*\.jsonl$/.test(first.source), first.source)
    t.eq('and both turns are in the same record', resumed.source, first.source)
  }

  t.section('a runtime that accepted the turn but sent its default effort FAILS the level')
  {
    process.env.CODEX_HOME = await temp()
    const r = await run('codex', { rollout: true, mode: 'effort-ignored' }, { effort: 'xhigh' })
    t.eq('both turns completed', [stageNamed(r, 'first-turn')?.status, stageNamed(r, 'resume')?.status], ['pass', 'pass'])
    t.eq('so the turn was accepted', r.effortEvidence.first.accepted, true)
    t.eq('but the runtime recorded another level', r.effortEvidence.first.recorded, 'medium')
    t.eq('the effort stage fails', stageNamed(r, 'effort-first')?.status, 'fail')
    t.ok('naming both levels', /"medium".*"xhigh"|medium.*not "xhigh"/.test(stageNamed(r, 'effort-first')?.detail ?? ''), stageNamed(r, 'effort-first')?.detail)
    t.ok('the level is NOT verified', !effortVerified(r))
    t.ok('and the check does not pass', !passed(r))
  }

  t.section('a record naming another model is no evidence about the model under test')
  {
    process.env.CODEX_HOME = await temp()
    const r = await run('codex', { rollout: true, mode: 'model-substituted' }, { effort: 'xhigh' })
    t.eq('the effort line matched', r.effortEvidence.first.recorded, 'xhigh')
    t.eq('but the model did not', r.effortEvidence.first.model, { requested: 'gpt-6-astra', recorded: 'gpt-6-astra-mini' })
    t.eq('so the turn fails', stageNamed(r, 'effort-first')?.status, 'fail')
    t.ok('naming both models', /"gpt-6-astra-mini".*"gpt-6-astra"/.test(stageNamed(r, 'effort-first')?.detail ?? ''), stageNamed(r, 'effort-first')?.detail)
    t.ok('and the level is not verified', !effortVerified(r))
  }

  t.section('a level is never verified on a session check that failed, however well the effort matched')
  {
    process.env.CODEX_HOME = await temp()
    const r = await run('codex', { rollout: true, recall: false }, { effort: 'high' })
    t.eq('both effort turns matched', [r.effortEvidence.first.status, r.effortEvidence.resumed.status], ['pass', 'pass'])
    t.eq('but continuity failed', stageNamed(r, 'continuity')?.status, 'fail')
    t.ok('so the check did not pass', !passed(r))
    t.ok('and the level is NOT verified', !effortVerified(r))
  }

  t.section('a different effort on resume tells an honoured override from an inherited one')
  {
    process.env.CODEX_HOME = await temp()
    const honoured = await run('codex', { rollout: true }, { effort: 'high', resumeEffort: 'low' })
    t.eq('the resumed turn asked for the other level', honoured.resumeEffort, 'low')
    t.eq('the record shows high then low', [honoured.effortEvidence.first.recorded, honoured.effortEvidence.resumed.recorded], ['high', 'low'])
    t.ok('the SWITCH is verified', effortSwitchVerified(honoured))
    t.ok('but no LEVEL is — high was never tested on a resumed turn, low never on a fresh one', !effortVerified(honoured))
    t.ok('and the summary says both', /requested high then low on resume/.test(describeText(honoured)) && /switch verified; neither level verified/.test(describeText(honoured)), describeText(honoured))
    t.eq('the ledger names the effort each invocation was made at', honoured.ledger.invocations.map((i) => [i.stage, i.effort]), [['first', 'high'], ['resume', 'low']])

    process.env.CODEX_HOME = await temp()
    const inherited = await run('codex', { rollout: true, mode: 'resume-inherits' }, { effort: 'high', resumeEffort: 'low' })
    t.eq('the fresh turn was honoured', inherited.effortEvidence.first.status, 'pass')
    t.eq('the resumed turn kept the session\'s first level', inherited.effortEvidence.resumed.recorded, 'high')
    t.eq('which fails the resumed stage', stageNamed(inherited, 'effort-resumed')?.status, 'fail')
    t.ok('switch not verified', !effortSwitchVerified(inherited))
    t.ok('and no level either', !effortVerified(inherited))

    // The same runtime with the SAME level on both turns cannot see the difference.
    process.env.CODEX_HOME = await temp()
    const blind = await run('codex', { rollout: true, mode: 'resume-inherits' }, { effort: 'high' })
    t.ok('equal levels pass on an inheriting runtime — the limit the switch exists for', effortVerified(blind))
    t.ok('and an equal-level run is never a switch', !effortSwitchVerified(blind))
  }

  t.section('a resume effort without a first effort is a misuse, not a check')
  {
    let error = null
    try { await run('codex', { rollout: true }, { resumeEffort: 'low' }) } catch (e) { error = e }
    t.ok('refused', /resumeEffort needs an effort/.test(error?.message ?? ''), error?.message)
  }

  t.section('without a session record an accepted effort is inconclusive, never verified')
  {
    process.env.CODEX_HOME = await temp()
    const r = await run('codex', { rollout: false }, { effort: 'high' })
    t.eq('the turns themselves passed', [stageNamed(r, 'first-turn')?.status, stageNamed(r, 'resume')?.status], ['pass', 'pass'])
    t.eq('the effort stage is inconclusive', stageNamed(r, 'effort-first')?.status, 'inconclusive')
    t.ok('saying the record is missing', /no session record/.test(stageNamed(r, 'effort-first')?.detail ?? ''), stageNamed(r, 'effort-first')?.detail)
    t.eq('accepted, but nothing recorded', [r.effortEvidence.first.accepted, r.effortEvidence.first.recorded, r.effortEvidence.first.effective], [true, null, null])
    t.ok('not verified', !effortVerified(r))
    t.ok('and inconclusive does not pass', !passed(r))
  }

  t.section('an adapter without a session record cannot verify an effort at all')
  {
    const r = await run('claude', {}, { effort: 'high' })
    t.eq('the session check itself passes its own stages', [stageNamed(r, 'first-turn')?.status, stageNamed(r, 'continuity')?.status], ['pass', 'pass'])
    t.eq('the effort stage is inconclusive', stageNamed(r, 'effort-first')?.status, 'inconclusive')
    t.ok('saying why', /no session record to read/.test(stageNamed(r, 'effort-first')?.detail ?? ''), stageNamed(r, 'effort-first')?.detail)
    t.ok('not verified', !effortVerified(r))
  }

  t.section('no effort asked: no effort stages, no evidence claimed')
  {
    delete process.env.CODEX_HOME
    const r = await run('codex')
    t.eq('no effort on the result', r.effort, null)
    t.eq('no evidence block', r.effortEvidence, null)
    t.ok('no effort stage', !r.stages.some((s) => s.name.startsWith('effort')))
    t.ok('not verified — nothing was asked', !effortVerified(r))
  }

  t.section('a session that carries its id but forgets the conversation fails')
  {
    const r = await run('claude', { recall: false })
    t.eq('the id still carried over', r.sessions.continuous, true)
    t.eq('but the runtime did not recall', r.remembered, false)
    t.ok('so the check does NOT pass', !passed(r))
    const continuity = r.stages.find((s) => s.name === 'continuity')
    t.eq('and continuity is the failing stage', continuity.status, 'fail')
    t.ok('with an explanation', /may not have/.test(continuity.detail), continuity.detail)
  }

  t.section('a failed first turn is recorded as an attempt with unknown cost')
  {
    const r = await run('claude', { mode: 'runtime-error' })
    t.ok('the check does not pass', !passed(r))
    t.eq('one attempt recorded', r.ledger.invocations.length, 1)
    t.eq('marked failed', r.ledger.invocations[0].outcome, 'failed')
    t.eq('its cost is unknown, not zero', r.ledger.costUnknownCalls, 1)
    t.ok('the runtime\'s own diagnostic is preserved, not just the exit code',
      /credential rejected/.test(r.ledger.invocations[0].detail ?? ''), r.ledger.invocations[0].detail)
    t.eq('classified as a runtime error', r.ledger.invocations[0].kind, 'runtime-error')
    t.eq('and no second turn was attempted', r.ledger.invocations.filter((i) => i.stage === 'resume').length, 0)
    t.eq('authentication is NOT claimed', r.demonstrated.authentication, 'unknown')
  }

  t.section('the invocation cap stops the second turn')
  {
    const r = await run('claude', {}, { maxInvocations: 1 })
    t.eq('only one invocation happened', r.ledger.invocations.length, 1)
    t.ok('the run stopped', !passed(r))
    t.eq('the resume stage failed on the cap', r.stages.at(-1).name, 'resume')
    t.ok('naming the cap', /invocation cap/.test(r.stages.at(-1).detail ?? ''), r.stages.at(-1).detail)
  }

  t.section('a missing binary at an effort: nothing invoked, so the level is not even attempted')
  {
    process.env.DEVPANEL_CODEX_BIN = '/nonexistent/not-a-cli'
    const adapter = await import('../../harness/codex.mjs')
    const ledger = createLedger()
    const r = await runSessionCheck({ adapter, harnessId: 'codex', model: 'gpt-6-astra', effort: 'high', workspace: await temp(), ledgerDir: await temp(), ledger })
    t.eq('installation failed', r.stages[0].status, 'fail')
    t.eq('no invocation carries the effort', ledger.invocations.filter((i) => i.effort === 'high').length, 0)
    t.ok('not verified', !effortVerified(r))
  }

  t.section('a missing binary is reported before anything is spent')
  {
    process.env.DEVPANEL_CLAUDE_BIN = '/nonexistent/not-a-cli'
    const adapter = await import('../../harness/claude.mjs')
    const ledger = createLedger()
    const r = await runSessionCheck({
      adapter, harnessId: 'claude', model: 'claude-haiku-4-5',
      workspace: await temp(), ledgerDir: await temp(), ledger
    })
    t.eq('installation failed', r.stages[0].status, 'fail')
    t.eq('nothing was invoked', ledger.invocations.length, 0)
    t.ok('and the check does not pass', !passed(r))
  }

  await Promise.all(temps.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})))
  delete process.env.DEVPANEL_CLAUDE_BIN
  delete process.env.DEVPANEL_CODEX_BIN
  delete process.env.CODEX_HOME
}
