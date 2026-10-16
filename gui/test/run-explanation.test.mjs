import { explainRun } from '../server/runtime/run-explanation.mjs'

export default async function (t) {
  t.section('live and waiting runs')
  t.eq('a running run names who is working', explainRun({ status: 'running' }, { active: [{ role: 'auditor-1' }] }).detail, 'Reviewer 1 is working.')
  t.eq('a question waits for an answer', explainRun({ status: 'paused', pause: { question: 'Which mailbox?' } }).headline, 'Waiting for your answer')
  t.eq('and quotes the question', explainRun({ status: 'paused', pause: { question: 'Which mailbox?' } }).detail, 'Which mailbox?')
  t.eq('a manual pause is only paused', explainRun({ status: 'paused', pause: { kind: 'manual' } }).tone, 'waiting')
  t.ok('an operator request names the project action',
    explainRun({ status: 'paused', pause: { request: { reason: 'Needs a dump.', projectAction: 'push' } } }).next.includes('"push"'))

  t.section('launch refusals are recognised')
  const dirty = explainRun({ status: 'failed', blockedReason: 'base policy "head" requires a clean checkout, but 812 tracked path(s) are modified in /opt/x. Choose base …' })
  t.eq('a dirty checkout says so', dirty.headline, "Couldn't start: the project has uncommitted changes")
  t.ok('with the count', dirty.detail.startsWith('812 files'))
  const link = explainRun({ status: 'failed', blockedReason: '1 symlink(s) in the checkout point outside it (a/b -> /opt/c). A write …' })
  t.ok('a symlink names the link, not "(s)"', link.detail.startsWith('a/b -> /opt/c'), link.detail)
  const unknown = explainRun({ status: 'failed', blockedReason: 'something new broke\nsecond line' })
  t.eq('an unknown refusal is quoted as the cause', unknown.cause, 'something new broke')
  t.eq('a preflight refusal quotes what failed, not that it refused',
    explainRun({ status: 'failed', blockedReason: 'preflight-refused', preflight: { detail: 'refusing to launch: x\n  fail: codex/m: denied' } }).cause, 'fail: codex/m: denied')

  t.section('runtime failures are classified')
  const auth = explainRun({ status: 'failed', failure: { class: 'auth', role: 'coordinator', message: 'login expired' }, participants: { coordinator: { model: 'opus' } } })
  t.eq('an auth failure is a sign-in problem', auth.headline, "Stopped: the coordinator's AI tool is not signed in")
  t.eq('the recorded message is the cause, verbatim', auth.cause, 'login expired')
  t.eq('a quota failure names the model', explainRun({ status: 'failed', failure: { class: 'quota', availability: { modelId: 'gpt-6' } } }).headline, 'Stopped: gpt-6 reached its usage limit')

  t.section('blocked runs explain the first unmet condition')
  const conditions = { sameRevisionApproval: true, checksSatisfied: true, noOutstandingBlockingFindings: true, coordinatorConfirmation: false, deliveryCompleted: false }
  const outputs = {
    '009': { valid: true, contract: 'closureConfirmation', output: { satisfied: false, criteria: [{ id: 'AC1', met: true }, { id: 'AC2', met: false, evidence: 'Not reproduced.' }], reasoning: 'AC2 rests on one report.' } },
    '004': { valid: true, contract: 'closureConfirmation', output: { satisfied: false, criteria: [], reasoning: 'older' } }
  }
  const unmet = explainRun({ status: 'blocked', blockedReason: 'closure-conditions-unmet', closure: { conditions }, steps: [] }, { outputs })
  t.eq('goals not met are counted', unmet.headline, 'Not finished: 1 goal of 2 not met')
  t.eq('the latest confirmation is the one read', unmet.detail, 'AC2 rests on one report.')
  t.eq('each unmet goal carries its evidence', unmet.unmet, [{ id: 'AC2', text: 'Not reproduced.' }])
  t.eq('checks come before sign-off', explainRun({ status: 'blocked', blockedReason: 'closure-conditions-unmet', closure: { conditions: { ...conditions, checksSatisfied: false } }, steps: [] }, { outputs }).headline,
    'Not finished: the automated checks did not pass')
  t.eq('a spent budget names which one',
    explainRun({ status: 'blocked', blockedReason: 'budget-exhausted', budgets: { limits: { maxSteps: 10, wallClockMinutes: 60 }, used: { steps: 10 } } }).headline, 'Stopped: it used up its turn limit')
  const delivery = explainRun({ status: 'blocked', blockedReason: 'source-delivery-blocked', delivery: { error: 'Source composition changed outside the approved patch.' }, workspace: { state: 'retained' } })
  t.eq('a delivery error is kept apart as the cause', delivery.cause, 'Source composition changed outside the approved patch.')
  t.eq('and the retained workspace is mentioned', delivery.kept, 'Its workspace and logs are kept.')
  t.eq('an unknown reason is still stated', explainRun({ status: 'blocked', blockedReason: 'brand-new-reason' }).detail, 'Reason recorded: brand-new-reason.')
  const gate = explainRun({ status: 'blocked', blockedReason: 'closure-conditions-unmet', closure: { conditions, notReturned: 'AC2: owner-gate' }, steps: [] }, { outputs })
  t.eq('an unmet goal kept for the operator says why it was not returned', gate.detail, 'AC2 rests on one report. It was not returned to the author: AC2 is a matter for you (owner gate).')
  const back = { closureReturns: [{ criteria: [{ id: 'AC2', unmet: 'missing-work' }] }] }
  t.eq('a run back with the author after closure says so while it runs', explainRun({ status: 'running', ...back }, { active: [{ role: 'implementer' }] }).headline, 'Running: returned to the author after closure')
  t.ok('naming the goal and the bound', /AC2 \(missing-work\).*return 1 of 2/.test(explainRun({ status: 'running', ...back }).detail))
  t.eq('a new selftest failure is named when checks stop closure',
    explainRun({ status: 'blocked', blockedReason: 'closure-conditions-unmet', closure: { conditions: { ...conditions, checksSatisfied: false }, checks: { selftest: { verdict: 'new-failures', newFailures: [{ command: 'collect', test: 'socket — new-test' }], baselineKnown: [{ command: 'collect', test: 'socket — old-test' }] } } }, steps: [] }, { outputs }).detail,
    'New selftest failures: socket — new-test. 1 other selftest failure also occurs on the unchanged project and did not count.')

  t.section('interrupted work is not a plain failure')
  const cut = explainRun({ status: 'failed', blockedReason: 'CLI exited before recording the outcome', participants: { author: { state: 'recovery-required', pendingInvocation: { invocationId: 'x' } } } })
  t.eq('a step left in flight reads as interrupted', cut.headline, 'Interrupted — needs recovery')
  t.eq('with the recorded reason as the cause', cut.cause, 'CLI exited before recording the outcome')
  t.eq('a panel restart keeps its own wording', explainRun({ status: 'blocked', blockedReason: 'recovery-required', participants: { author: { pendingInvocation: {} } } }).headline,
    'Interrupted: the panel restarted while this run was working')
  const quarantined = explainRun({ status: 'blocked', blockedReason: 'recovery-required', integrity: { status: 'quarantined', latest: { changes: { changed: true } } },
    recovery: { required: true, reason: 'Source integrity: unsuccessful invocation left partial source or Git changes. Workspace retained at /x', cause: { class: 'transient', message: 'claude exited 1' } } })
  t.eq('a source-integrity quarantine is not called a restart', quarantined.headline, 'Stopped: a turn left source changes that need a recovery decision')
  t.eq('it names the turn\'s failure', quarantined.detail, 'The turn failed (transient: claude exited 1).')
  t.ok('and the quarantine reason', /^Source integrity: unsuccessful invocation/.test(quarantined.cause), quarantined.cause)
  t.eq('a journal fault keeps the generic wording', explainRun({ status: 'blocked', blockedReason: 'recovery-required', journal: { recoveryRequired: true }, integrity: { status: 'quarantined', latest: { changes: { changed: true } } } }).headline,
    'Interrupted: the panel restarted while this run was working')

  t.section('finished runs say what they achieved')
  t.eq('patch-only delivery leaves the project unchanged',
    explainRun({ status: 'completed', outcome: 'resolved', delivery: { action: 'worktree-diff', completedAt: 'x' } }).headline, 'Done: a patch is ready')
  t.eq('source delivery is in the project',
    explainRun({ status: 'completed', outcome: 'resolved', delivery: { action: 'apply-to-source', completedAt: 'x' } }).headline, 'Done: the change is in your project')
  t.eq('a report counts its findings',
    explainRun({ status: 'completed', outcome: 'resolved', reportDisposition: { issues: [{}, {}], response: 'Two.' } }).headline, 'Done: report with 2 findings')
  t.eq('a cancelled run was stopped by an operator', explainRun({ status: 'cancelled' }).headline, 'Stopped by an operator')
  t.section('a landing by hand')
  const landed = { by: 'alice', applied: 'the approved patch', commit: 'abc1234', handChanges: 'renamed one constant', landedAt: '2026-10-07T10:00:00.000Z', recordedAt: '2026-10-07T10:05:00.000Z' }
  const blocked = { status: 'blocked', outcome: 'unresolved', blockedReason: 'source-delivery-blocked', workspace: { state: 'retained' }, landed }
  const said = explainRun(blocked)
  t.eq('says it was landed by hand, and by whom', [said.headline, said.tone], ['Landed by hand by alice', 'success'])
  t.ok('with where it went and what was changed beyond the patch', said.detail.includes('commit abc1234') && said.detail.includes('renamed one constant'), said.detail)
  t.ok('and how the run itself ended', said.detail.includes('Approved, but it could not be applied to your project'), said.detail)
  t.eq('the record is not changed by explaining it', [blocked.status, blocked.outcome, blocked.blockedReason], ['blocked', 'unresolved', 'source-delivery-blocked'])
  t.ok('a checkout path is named when there is no commit', explainRun({ status: 'completed', outcome: 'resolved', delivery: { action: 'worktree-diff', completedAt: 'x' }, landed: { ...landed, commit: null, checkout: '/opt/x-project' } }).detail.includes('/opt/x-project'))
  t.eq('no run, no explanation', explainRun(null), null)
}
