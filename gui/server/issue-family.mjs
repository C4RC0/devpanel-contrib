/*
 * An issue's family, from two relations kept apart on purpose:
 *
 *   provenance  `openedBy.from` (opened-by.mjs): the one issue it came out of, fixed at creation, so a tree;
 *   order       `dependsOn` (issue-dependencies.mjs): issues to settle first, changed later, so a graph.
 *
 * Provenance implies no order: a follow-up or a finding is opened when its parent's run has ended, so making
 * it wait for the parent would hold nothing back or hold it back for a disposition nobody owes. Only an
 * accepted split writes order, as a chain of its parts (owner-input.mjs).
 *
 * Derived on every read from the issues given, never stored. Pure: the caller decides what "the issues" are
 * (listIssues passes the project's folders, which leaves packed issues out; they are settled, so open counts
 * and waits stay right, and only their names are missing).
 */

/** Settled: decided (a disposition) or put away (archived, packed). What a prerequisite must be to stop holding. */
export const settled = (issue) => Boolean(issue.disposition || issue.archived || issue.packed)

const key = (project, id) => `${project}/${id}`

/** A list-sized description of an issue as a family member. */
export const brief = (issue) => ({
  project: issue.project,
  id: issue.id,
  name: issue.name ?? issue.id,
  disposition: issue.disposition?.value ?? null,
  archived: Boolean(issue.archived),
  packed: Boolean(issue.packed),
  settled: settled(issue),
  run: issue.latestRun ? { status: issue.latestRun.status, live: Boolean(issue.latestRun.live), result: issue.latestRun.result ?? null } : null
})

/**
 * Every issue's family links, keyed `project/id`: `parent` (with `via`, and `known: false` when the parent
 * is not among the issues given), `children` and `openChildren`, `waitingOn` (its unsettled prerequisites;
 * one in another project is `unknown`, since only this project was read) and `blocks` (unsettled issues
 * waiting for it while it is unsettled itself).
 */
export function families (issues, project) {
  const byKey = new Map(issues.map((i) => [key(i.project ?? project, i.id), i]))
  const out = new Map()
  const entry = (k) => out.get(k) ?? out.set(k, { parent: null, children: [], openChildren: 0, waitingOn: [], blocks: [] }).get(k)
  for (const issue of issues) {
    const k = key(issue.project ?? project, issue.id)
    const me = entry(k)
    const from = issue.openedBy?.from
    if (from?.issueId) {
      const pk = key(from.project ?? project, from.issueId)
      const parent = byKey.get(pk)
      me.parent = { project: from.project ?? project, id: from.issueId, via: from.via, runId: from.runId ?? null, known: Boolean(parent), name: parent?.name ?? null }
      if (parent) {
        const p = entry(pk)
        p.children.push(issue.id)
        if (!settled(issue)) p.openChildren++
      }
    }
    if (settled(issue)) continue
    for (const d of issue.dependsOn?.issues ?? []) {
      const dk = key(d.project, d.id)
      const dep = byKey.get(dk)
      if (d.project !== project && !dep) { me.waitingOn.push({ project: d.project, id: d.id, unknown: true }); continue }
      // Absent here means packed or deleted: neither holds anything up (openDependencies reads it the same).
      if (!dep || settled(dep)) continue
      me.waitingOn.push({ project: d.project, id: d.id, name: dep.name })
      entry(dk).blocks.push(issue.id)
    }
  }
  return out
}
