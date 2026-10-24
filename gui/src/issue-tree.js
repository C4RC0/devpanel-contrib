/*
 * The issue list as a provenance tree: each issue under the one it came out of (`family.parent`, server
 * issue-family.mjs), children in the order they were opened, roots in the list's own order (newest first).
 *
 * A parent that is not in this list (archived while its children are active, an inquiry, another project)
 * stands in as a ghost row, so siblings stay together and the way back is one click. Only order follows
 * provenance here; what waits for what is the `dependsOn` graph and is shown as tags, never as nesting.
 */

const parentKey = (item, project) => {
  const p = item.family?.parent
  return p ? `${p.project ?? project}/${p.id}` : null
}

/** Rows `{ item, depth, childCount, ghost }` for `issues`, leaving out the descendants of `collapsed` keys. */
export function treeRows (issues, project, collapsed = new Set()) {
  const key = (item) => `${item.project ?? project}/${item.id}`
  const listed = new Map(issues.map((i) => [key(i), i]))
  const children = new Map()
  const ghosts = new Map()
  const roots = []
  for (const item of issues) {
    const pk = parentKey(item, project)
    if (!pk) { roots.push(item); continue }
    if (!listed.has(pk) && !ghosts.has(pk)) {
      const p = item.family.parent
      const ghost = { id: p.id, project: p.project ?? project, name: p.name ?? p.id, ghost: true }
      ghosts.set(pk, ghost)
      roots.push(ghost)                     // where its newest child would have stood
    }
    if (!children.has(pk)) children.set(pk, [])
    children.get(pk).push(item)
  }
  const rows = []
  const seen = new Set()
  // Hidden descendants are still walked, so the fallback below does not list them flat.
  const visit = (item, depth, shown = true) => {
    const k = key(item)
    if (seen.has(k)) return                 // a provenance cycle cannot be written, but a hand-edited file can hold one
    seen.add(k)
    const kids = (children.get(k) ?? []).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    if (shown) rows.push({ item, depth, childCount: kids.length, ghost: Boolean(item.ghost), key: k })
    for (const kid of kids) visit(kid, depth + 1, shown && !collapsed.has(k))
  }
  for (const root of roots) visit(root, 0)
  // Anything only reachable through a cycle is still listed, flat.
  for (const item of issues) if (!seen.has(key(item))) visit(item, 0)
  return rows
}

/** Tags for an issue's family links: open sub-issues, what it waits for, what it holds up. */
export function familyTags (family) {
  if (!family) return []
  const tags = []
  if (family.openChildren) tags.push({ key: 'children', text: `${family.openChildren} open sub-issue${family.openChildren === 1 ? '' : 's'}`, color: 'info', title: `${family.children.length} issue(s) came out of this one; ${family.openChildren} not settled yet` })
  for (const w of family.waitingOn ?? []) {
    tags.push({ key: `wait:${w.project}/${w.id}`, text: `waits for ${w.unknown ? `${w.project}/${w.id}` : w.name ?? w.id}`, color: 'warning', icon: '$clock', title: w.unknown ? 'A prerequisite in another project; open the issue to see whether it is settled' : `Prerequisite not settled yet: ${w.id}. The supervisor will not start this issue before it is.` })
  }
  if (family.blocks?.length) tags.push({ key: 'blocks', text: `holds up ${family.blocks.length}`, title: `Waiting for this one: ${family.blocks.join(', ')}` })
  return tags
}
