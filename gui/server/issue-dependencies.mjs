import fs from 'node:fs/promises'
import path from 'node:path'
import { getIssue, IssueError } from './issues.js'
import { writeJson } from './runtime/persistence.mjs'

/*
 * Prerequisites between issues. A run on an issue whose prerequisite is still
 * open spends a start to learn that it must wait: an issue started before the
 * one whose rule it depends on can only have its triage ask the owner.
 * Recorded by an operator or the supervisor,
 * shown as `waitingOn` in the supervisor's overview, and the supervisor's
 * start_run refuses an issue while one is open. An operator may still start
 * it from the panel: the order is management, not a lock.
 *
 * A prerequisite is settled once it has a disposition or is archived.
 */

const settled = (issue) => Boolean(issue.disposition || issue.archived || issue.packed)

const parse = (project, ref) => ref.includes('/') ? ref.split('/', 2) : [project, ref]

export async function setIssueDependencies (project, id, { dependsOn, reason, by = 'operator' } = {}, { getIssue: read = getIssue } = {}) {
  if (!Array.isArray(dependsOn) || dependsOn.some((r) => typeof r !== 'string' || !r.trim())) throw new IssueError('dependsOn must be a list of issue ids (same project, or project/id)')
  if (dependsOn.length && (typeof reason !== 'string' || !reason.trim())) throw new IssueError('dependencies need a reason: say what the issue waits for')
  if (!['operator', 'supervisor'].includes(by)) throw new IssueError('by must be operator or supervisor')
  const issue = await read(project, id)
  if (issue.packed) throw new IssueError('an archived issue cannot be changed', 409)
  if (issue.kind === 'inquiry') throw new IssueError('an inquiry has no dependencies', 409)
  const issues = []
  for (const ref of new Set(dependsOn.map((r) => r.trim()))) {
    const [p, i] = parse(project, ref)
    if (p === project && i === id) throw new IssueError('an issue cannot depend on itself')
    const dep = await read(p, i).catch(() => { throw new IssueError(`issue ${ref} does not exist`, 404) })
    // A direct cycle would hold both forever; longer ones are left to people.
    if ((dep.dependsOn?.issues ?? []).some((d) => d.project === project && d.id === id)) throw new IssueError(`${ref} already depends on this issue`)
    issues.push({ project: p, id: i })
  }
  const file = path.join(issue.path, 'issue.json')
  let meta = {}
  try { meta = JSON.parse(await fs.readFile(file, 'utf8')) } catch { meta = {} }
  meta.dependsOn = issues.length ? { issues, reason: reason.trim(), by, at: new Date().toISOString() } : null
  await writeJson(file, meta)
  return read(project, id)
}

/** The prerequisites of `issue` that are not settled yet, with their names. `getIssue` is injectable for tests. */
export async function openDependencies (issue, { getIssue: read = getIssue } = {}) {
  const open = []
  for (const dep of issue.dependsOn?.issues ?? []) {
    const found = await read(dep.project, dep.id).catch(() => null)
    // A prerequisite that was deleted can no longer hold anything up.
    if (found && !settled(found)) open.push({ project: dep.project, id: dep.id, name: found.name })
  }
  return open
}
