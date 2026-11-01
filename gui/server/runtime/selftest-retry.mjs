/*
 * A drive that passed but whose selftest report names failures the base does
 * not have (verdict `new-failures`) fails the gate as surely as a failed
 * command, yet retryFailedCheck only reran failed RESULTS. Such a "new"
 * failure is often one test that is unstable on the staging instance, and the
 * author was sent another round for it, answered with the same revision, and
 * the run stopped `checks-failed-unchanged`. Here the drive runs once more on
 * the same revision (the same `target.retryFailed` allowance, never on top of
 * an earlier retry): a retry whose report clears the new failures replaces the
 * first drive and is marked `flaky`, like any retried pass; one that names any
 * of them again keeps the first drive, now recorded as reproduced. A retry
 * that did not pass proves nothing about the selftests and only joins the
 * attempts. Called by engine.mjs after the base comparison, with the engine's
 * own drive and comparison injected.
 */
export async function retryNewSelftestFailures ({ result, limit, aborted, rerun, compare, record, persist }) {
    const selftest = result.baselineComparison?.selftest
    if (selftest?.verdict !== 'new-failures' || result.result !== 'passed' || result.attempts?.length || !(limit > 0) || aborted()) return result
    await persist({ type: 'checks-retry', revision: result.revision, attempt: 2, failedDir: result.dir, reason: 'new-selftest-failures' })
    const retry = await rerun()
    if (retry.result !== 'passed') return { ...result, attempts: [record(retry)] }
    const again = await compare(retry)
    const named = new Set(selftest.newFailures.map((f) => `${f.command} ${f.test}`))
    const reproduced = (again.selftest?.newFailures ?? []).some((f) => named.has(`${f.command} ${f.test}`))
    if (reproduced || again.selftest?.verdict === 'not-made') return { ...result, attempts: [{ ...record(retry), newFailures: again.selftest?.newFailures ?? [] }], selftestReproduced: true }
    return { ...retry, baselineComparison: again, attempts: [{ ...record(result), newFailures: selftest.newFailures }], flaky: true }
}
