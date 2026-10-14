/*
 * What is waiting on a person, across every project.
 *
 * Most of the time an issue spent "being resolved" was a run parked in a state
 * only a person could move — blocked on a budget, stranded by a restart, paused
 * on a question — with nothing pointing at it. This is that pointer: the newest
 * run of each open issue, when it is in such a state, with how long it has been
 * waiting. Read from the list summaries (cached by file version), so it costs
 * no more than the issue lists already do.
 */

const KIND = (issue, run) => {
  if (!run) return null
  if (run.status === 'paused') return run.pauseQuestion ? 'question' : 'paused'
  if (run.ownerInput && !run.ownerInput.answered) return 'question'
  if (run.recoveryRequired) return 'recovery'
  if (run.status === 'blocked') return 'blocked'
  if (run.status === 'failed') return 'failed'
  if (run.status === 'completed' && run.outcome === 'resolved' && !issue.disposition) return 'disposition'
  return null
}

// A question or a stranded run holds work in progress; a missing disposition does not.
const ORDER = { question: 0, recovery: 1, blocked: 2, paused: 3, failed: 4, disposition: 5 }

export async function attentionList ({ listProjects, listIssues, now = Date.now() }) {
  const out = []
  for (const project of await listProjects()) {
    const projectId = project.id ?? project.name ?? project
    let issues = []
    try { issues = await listIssues(projectId) } catch { continue }
    for (const issue of issues) {
      // An inquiry's endings are the supervisor's to close (Phase 4), not a person's to-do.
      if (issue.kind === 'inquiry') continue
      if (issue.disposition) {
        // Decided; only an unfinished newest run still needs a person.
        if (!['paused', 'blocked'].includes(issue.latestRun?.status)) continue
      }
      const run = issue.latestRun
      const kind = KIND(issue, run)
      if (!kind) continue
      const since = run.updatedAt ?? run.endedAt ?? run.startedAt
      out.push({
        kind,
        project: projectId,
        issueId: issue.id,
        issueName: issue.name,
        priority: issue.priority?.value ?? null,
        runId: run.runId,
        playbook: run.playbook,
        status: run.status,
        blockedReason: run.blockedReason,
        headline: run.explanation?.headline ?? null,
        detail: run.pauseQuestion ?? (run.ownerInput && !run.ownerInput.answered ? (run.ownerInput.verdict === 'too-large' ? `Too large for one run: ${run.ownerInput.parts} parts proposed` : run.ownerInput.questions.join(' · ')) : null) ?? run.explanation?.detail ?? run.recoveryReason ?? run.resultReason ?? null,
        since,
        waitingMs: since ? Math.max(0, now - Date.parse(since)) : null
      })
    }
  }
  return out.sort((a, b) => (ORDER[a.kind] - ORDER[b.kind]) || ((b.waitingMs ?? 0) - (a.waitingMs ?? 0)))
}
