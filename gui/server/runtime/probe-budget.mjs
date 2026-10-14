/*
 * A budgeted, explicitly-authorised executor for harness probes.
 *
 * Installation probes are free. Anything deeper spends money, because proving
 * that credentials work or that a model is reachable means using it. A diagnostic
 * command must therefore not be able to reach those depths by accident, and
 * whatever does reach them must be counted.
 */

const FREE_DEPTH = 'installation'

export class ProbeNotAuthorised extends Error {
  constructor (depth) {
    super(`probing at depth "${depth}" costs money: authorise it explicitly and supply an invocation budget`)
    this.name = 'ProbeNotAuthorised'
    this.depth = depth
  }
}

export class ProbeBudgetExceeded extends Error {
  constructor (used, cap) {
    super(`probe invocation budget exhausted (${used} of ${cap})`)
    this.name = 'ProbeBudgetExceeded'
  }
}

/**
 * @param load          async (harnessId) => adapter module
 * @param allowPaid     whether depths beyond installation are permitted at all
 * @param maxInvocations hard cap on probe calls; the only limit enforceable before spending
 * @param onSpend       called with every probe result that attempted a call
 */
export function createProbeExecutor ({ load, allowPaid = false, maxInvocations = 0, onSpend = null } = {}) {
  const spent = { invocations: 0, tokens: 0, costUsd: 0, costUnknownCalls: 0 }

  const execute = async (harnessId, options = {}) => {
    const depth = options.depth ?? FREE_DEPTH

    if (depth !== FREE_DEPTH) {
      if (!allowPaid) throw new ProbeNotAuthorised(depth)

      // Reserve before calling: cost is only knowable afterwards, so the count is
      // the only thing that can be checked in advance.
      const wanted = Math.max(1, (options.models ?? []).length)
      if (spent.invocations + wanted > maxInvocations) {
        throw new ProbeBudgetExceeded(spent.invocations + wanted, maxInvocations)
      }
      spent.invocations += wanted
    }

    const adapter = await load(harnessId)
    const result = await adapter.probe(options)

    // Count what was ATTEMPTED, not what succeeded — a failed call may still cost.
    if (result.invocations) {
      spent.tokens += result.usage?.tokens ?? 0
      spent.costUsd += result.usage?.costUsd ?? 0
      spent.costUnknownCalls += result.usage?.costUnknownCalls ?? 0
      onSpend?.(result)
    }
    return result
  }

  execute.spent = spent
  execute.summary = () => spent.costUnknownCalls
    ? `${spent.invocations} probe call(s), at least $${spent.costUsd.toFixed(4)} (${spent.costUnknownCalls} reported no cost)`
    : `${spent.invocations} probe call(s), $${spent.costUsd.toFixed(4)}`

  return execute
}
