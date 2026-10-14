import path from 'node:path'

import { confidentAnswer } from './index.mjs'

/*
 * Second opinion on runtime failures (rollout step 5 of docs/decisions.md).
 *
 * runtime/failure.mjs classifies a failed turn from the runtime's own words
 * with regular expressions. What none of them matches is `runtime`, which fails
 * the run. That bucket holds real defects and also provider hiccups phrased in
 * words no rule anticipated. For those, and only those, the decision provider
 * is asked whether the failure looks temporary.
 *
 * The options are `runtime`, `transient` and `rate-limit`, and nothing else:
 * `quota` and `auth` change host-wide state (an availability hold) or need a
 * person, so they stay with the regular expressions, which quote the text they
 * matched. A confident `transient` or `rate-limit` makes the attempt retryable
 * under the run's own retry policy, which still bounds how often. Anything else
 * leaves the failure exactly as classified.
 *
 * The answer is recorded under the run before it is acted on, keyed by the
 * failed invocation, so a replay takes the same branch without asking again.
 */

export const FAILURE_PURPOSE = 'failure-reclass'
const MAX_EVIDENCE_CHARS = 4000

export const FAILURE_QUESTIONS = {
  class: {
    type: 'choice',
    instructions: 'An AI coding runtime (a command-line agent calling a model provider) exited with an error during one turn. From its error output, will repeating the same call after a short wait most likely succeed?',
    criteria: {
      runtime: 'No: the error is a defect in the runtime, the request, the configuration or the environment, and the same call would fail the same way again.',
      transient: 'Yes: a temporary network or provider-side fault (a dropped connection, a server error, an interrupted stream) unrelated to the request itself.',
      'rate-limit': 'Yes, after waiting: the provider is throttling or overloaded and asks the caller to slow down.'
    }
  }
}

/**
 * @param advisor     decisions/advisor.mjs
 * @param deadlineMs  how long a failed turn waits for the provider before failing as it would have
 * @returns (failure) => { class: 'transient'|'rate-limit'|null, record }
 */
export function createFailureAdvisor ({ advisor, deadlineMs = 15000 }) {
  return async function adviseFailure ({ issuePath, runId, failure, signal = null }) {
    const deadline = AbortSignal.timeout(deadlineMs)
    const record = await advisor.ask({
      dir: path.join(issuePath, 'runs', runId, 'decisions'),
      purpose: FAILURE_PURPOSE,
      subject: { runId, invocationId: failure.invocationId, role: failure.role, stepId: failure.stepId },
      // The invocation id makes each failed attempt its own question.
      state: {
        invocationId: failure.invocationId,
        harness: failure.harness ?? null,
        model: failure.model ?? null,
        message: String(failure.message ?? '').slice(0, 1000),
        output: String(failure.evidence ?? '').slice(0, MAX_EVIDENCE_CHARS)
      },
      questions: FAILURE_QUESTIONS,
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline
    })
    const answer = confidentAnswer(record, 'class')
    return { class: answer && answer.value !== 'runtime' ? answer.value : null, record }
  }
}
