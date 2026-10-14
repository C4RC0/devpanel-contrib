import fs from 'node:fs/promises'

import { DEFAULT_TIMEZONE, toMicros } from './ledger.mjs'

/*
 * What a standing supervisor is allowed to spend, and when it stops.
 *
 * The lifetime fuse it replaced was never a ceiling — it burned once and took
 * the whole management plane with it, including for projects it had never
 * touched. Windows do the opposite: they refuse for a while and then let work
 * continue, which is what a bound on a standing service has to do.
 *
 * The policy is operator configuration, on disk, beside the ledger. It is read
 * and validated at startup and nothing infers it: an absent, unreadable or
 * invalid policy means money is bounded only by the session limits (so many
 * starts per session, so many per issue, so many model calls) until a person
 * fixes the file. Every refusal to activate says exactly what was wrong, so a
 * typo is a message rather than a silently unbounded supervisor.
 *
 * Retries per issue are NOT here. They are a session limit (maxStartsPerIssue)
 * because a retry guard protects against a looping conversation, not against
 * calendar spending; a `perIssueStarts` key from an older policy is ignored.
 */

export const POLICY_VERSION = 1

const WINDOWS = ['daily', 'monthly']
// Unpriced work is bounded per SUBJECT. One allowance shared between runs and
// model calls means whichever is noisier exhausts the other's budget while
// remaining unbounded itself — the calls, always, since there are many per run.
const CEILINGS = ['starts', 'usd', 'unpricedRuns', 'unpricedCalls']

const positive = (value, integer) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 && (!integer || Number.isInteger(value))

/**
 * Validate an operator's policy. Returns the reasons it cannot be used, and an
 * empty list means it can.
 */
export function policyErrors (policy) {
  const errors = []
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return ['the policy is not an object']
  if (policy.enforceAllowances != null && typeof policy.enforceAllowances !== 'boolean') errors.push('enforceAllowances must be a boolean')
  if (policy.version !== POLICY_VERSION) errors.push(`version must be ${POLICY_VERSION}`)
  // Only UTC windows exist in the ledger; a policy naming another zone would be
  // enforced against boundaries it did not mean.
  if ((policy.timezone ?? DEFAULT_TIMEZONE) !== DEFAULT_TIMEZONE) errors.push(`timezone must be ${DEFAULT_TIMEZONE}: no other window boundary is implemented`)
  for (const window of WINDOWS) {
    const limits = policy[window]
    if (!limits || typeof limits !== 'object') { errors.push(`${window} limits are missing`); continue }
    for (const key of CEILINGS) {
      if (!positive(limits[key], key !== 'usd')) errors.push(`${window}.${key} must be a positive ${key === 'usd' ? 'number' : 'integer'}`)
    }
  }
  for (const key of CEILINGS) {
    const day = policy.daily?.[key]
    const month = policy.monthly?.[key]
    // A daily ceiling above the monthly one is not a policy, it is two policies
    // that disagree; the tighter would silently win and the looser would be a lie.
    if (positive(day, key !== 'usd') && positive(month, key !== 'usd') && day > month) errors.push(`daily.${key} (${day}) exceeds monthly.${key} (${month})`)
  }
  if (!positive(policy.perWakeCalls, true)) errors.push('perWakeCalls must be a positive integer')
  if (!positive(policy.concurrent, true)) errors.push('concurrent must be a positive integer')
  return errors
}

/**
 * Read the policy from disk.
 *
 * Every failure is the same answer — not active, and why — because "absent",
 * "unparseable" and "invalid" all mean the replacement bound is not in force,
 * and the fuse must stay.
 */
export async function loadPolicy (file) {
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    return { active: false, policy: null, file, reason: error.code === 'ENOENT' ? 'no spending policy is configured' : `the spending policy cannot be read: ${error.code ?? error.message}` }
  }
  let parsed
  try { parsed = JSON.parse(text) } catch (error) { return { active: false, policy: null, file, reason: `the spending policy is not valid JSON: ${error.message}` } }
  const errors = policyErrors(parsed)
  if (errors.length) return { active: false, policy: null, file, reason: `the spending policy is invalid: ${errors.join('; ')}`, errors }
  const ignored = 'perIssueStarts' in parsed ? ['perIssueStarts is ignored: retries per issue are the session limit maxStartsPerIssue'] : []
  return { active: true, policy: parsed, file, reason: null, ...(ignored.length ? { ignored } : {}) }
}

/**
 * May this be admitted?
 *
 * Money is committed BEFORE it is spent: a window holds what it has settled plus
 * what is reserved and unaccounted for, so a crash mid-run cannot buy a second
 * run with the same allowance. A reservation without an explicitly configured
 * ceiling reserves no money at all — it consumes one of the unpriced allowance,
 * which is a separate resource, because a guess drawn from past runs is a
 * statement about runs that already happened.
 *
 * @param usage        ledger.usage(at)
 * @param wakeCalls    calls already made in this wake, from the ledger
 * @param maxCostUsd   an explicitly configured ceiling, or null for unpriced
 */
export function admits ({ policy, usage, subject, maxCostUsd = null, wakeCalls = 0, concurrent = 0 }) {
  const refuse = (limit, detail, until) => ({ ok: false, limit, detail, until: until ?? null })

  if (subject === 'model-call') {
    if (wakeCalls >= policy.perWakeCalls) {
      return refuse('perWakeCalls', `this wake has made ${wakeCalls} of ${policy.perWakeCalls} permitted model calls; it ends here rather than running on`, 'the next event')
    }
  }
  if (subject === 'run-start') {
    if (concurrent >= policy.concurrent) return refuse('concurrent', `${concurrent} of ${policy.concurrent} concurrent slots are held`, 'a run finishes')
  }

  // Cost and calendar allowances are telemetry unless the operator explicitly opts in.
  // Provider quota errors, not estimated prices, establish account exhaustion.
  if (policy.enforceAllowances !== true) return { ok: true }

  for (const [window, limits, held] of [['daily', policy.daily, usage.day], ['monthly', policy.monthly, usage.month]]) {
    const rolls = window === 'daily' ? 'the next UTC day' : 'the next UTC month'
    const limitMicros = toMicros(limits.usd)

    /*
     * Exhaustion first, for EVERY subject.
     *
     * An unpriced allowance is permission to take a risk while there is still
     * money — not a way around knowing the money is gone. Once the window's
     * committed spending has reached its ceiling, whether by reservations, by
     * settlements or by an overage, nothing further is admitted: not a priced
     * run, not an unpriced run, not a model call. Checking the unpriced
     * allowance first would let work whose price nobody knew in advance keep
     * going after the exhaustion was known for certain, which is the opposite of
     * what the allowance is for.
     */
    if (held.committedUsdMicros >= limitMicros) {
      const over = held.overageUsdMicros > 0 ? `, including $${held.overageUsd} spent beyond what was reserved` : ''
      return refuse(`${window}.usd`, `the ${window} allowance of $${limits.usd} is spent — $${held.committedUsd} is committed${over} — so nothing further is admitted, priced or not`, rolls)
    }
    if (subject === 'run-start' && held.starts >= limits.starts) {
      return refuse(`${window}.starts`, `${held.starts} of ${limits.starts} ${window} run starts are used`, rolls)
    }
    if (maxCostUsd != null) {
      // Integers throughout: a ceiling decided in floating point refuses runs it
      // has the money for.
      if (held.committedUsdMicros + toMicros(maxCostUsd) > limitMicros) {
        return refuse(`${window}.usd`, `$${held.committedUsd} of $${limits.usd} ${window} is committed; this would reserve $${maxCostUsd} more`, rolls)
      }
    } else {
      // Only now, with money left in the window, does the risk allowance apply.
      // Each subject draws on its own: a model call is unpriced by nature — its
      // cost exists only after it returns — so it is bounded by how many may be
      // made, not by money nobody can know in advance.
      if (subject === 'run-start' && held.unpricedRuns >= limits.unpricedRuns) {
        return refuse(`${window}.unpricedRuns`, `${held.unpricedRuns} of ${limits.unpricedRuns} ${window} runs without a configured cost ceiling are used; give the playbook a maxCostUsd budget or wait`, rolls)
      }
      if (subject === 'model-call' && held.unpricedCalls >= limits.unpricedCalls) {
        return refuse(`${window}.unpricedCalls`, `${held.unpricedCalls} of ${limits.unpricedCalls} ${window} model calls whose price the provider did not report are used`, rolls)
      }
    }
  }
  return { ok: true }
}

/** One sentence an operator or a model can act on. */
export const describeRefusal = (refusal) =>
  `${refusal.detail}. Refused until ${refusal.until}.`
