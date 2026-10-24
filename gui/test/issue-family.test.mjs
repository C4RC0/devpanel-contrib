import { engineFixture } from './fakes/fixture.mjs'
import { families } from '../server/issue-family.mjs'
import { setIssueDependencies } from '../server/issue-dependencies.mjs'
import { familyTags, treeRows } from '../src/issue-tree.js'

export const name = 'issue family — provenance tree, prerequisites and what they hold up'

const P = 'p'
const issue = (id, extra = {}) => ({ project: P, id, name: `Issue ${id}`, ...extra })
const from = (issueId, via = 'follow-up') => ({ openedBy: { user: 'engine', from: { project: P, issueId, via } } })

export default async function (t) {
  t.section('families: provenance and order are separate links')
  {
    const list = [
      issue('a'),
      issue('b', from('a')),
      issue('c', { ...from('a'), disposition: { value: 'resolved' } }),
      issue('d', { ...from('gone', 'split'), dependsOn: { issues: [{ project: P, id: 'a' }, { project: 'other', id: 'x' }, { project: P, id: 'packed' }] } }),
      issue('e', { dependsOn: { issues: [{ project: P, id: 'c' }] } })
    ]
    const f = families(list, P)
    t.eq('children in list order, open ones counted', [f.get('p/a').children, f.get('p/a').openChildren], [['b', 'c'], 1])
    t.eq('a parent not among the issues is named but unknown', f.get('p/d').parent, { project: P, id: 'gone', via: 'split', runId: null, known: false, name: null })
    t.eq('waits for the open prerequisite; another project is unknown; an absent one holds nothing',
      f.get('p/d').waitingOn, [{ project: P, id: 'a', name: 'Issue a' }, { project: 'other', id: 'x', unknown: true }])
    t.eq('the prerequisite says what it holds up', f.get('p/a').blocks, ['d'])
    t.eq('a settled prerequisite holds nothing up', [f.get('p/e').waitingOn, f.get('p/c').blocks], [[], []])
    t.eq('a parent is not a prerequisite', f.get('p/b').waitingOn, [])
  }

  t.section('treeRows: children under parents, ghosts for parents not listed, collapse')
  {
    // Newest first, as listIssues returns them.
    const list = [
      issue('2026-10-05-e', from('2026-10-01-old')),
      issue('2026-10-04-d', from('2026-10-02-b')),
      issue('2026-10-03-c', from('2026-10-01-old')),
      issue('2026-10-02-b'),
      issue('2026-10-01-a')
    ].map((i) => ({ ...i, family: i.openedBy ? { parent: { project: P, id: i.openedBy.from.issueId } } : null }))
    const rows = treeRows(list, P)
    t.eq('order and depth', rows.map((r) => `${r.depth}:${r.item.id}${r.ghost ? '(ghost)' : ''}`), [
      '0:2026-10-01-old(ghost)', '1:2026-10-03-c', '1:2026-10-05-e', '0:2026-10-02-b', '1:2026-10-04-d', '0:2026-10-01-a'
    ])
    t.eq('child counts', rows.map((r) => r.childCount), [2, 0, 0, 1, 0, 0])
    const folded = treeRows(list, P, new Set(['p/2026-10-01-old']))
    t.eq('a collapsed parent hides its children', folded.map((r) => r.item.id), ['2026-10-01-old', '2026-10-02-b', '2026-10-04-d', '2026-10-01-a'])
    const loop = [issue('x', { family: { parent: { project: P, id: 'y' } } }), issue('y', { family: { parent: { project: P, id: 'x' } } })]
    t.eq('a cycle is still listed, each issue once', treeRows(loop, P).map((r) => r.item.id).sort(), ['x', 'y'])
  }

  t.section('familyTags')
  {
    const tags = familyTags({ children: ['b', 'c'], openChildren: 1, waitingOn: [{ project: P, id: 'a', name: 'Rule' }], blocks: ['z'] })
    t.eq('open sub-issues, waits, holds up', tags.map((x) => x.text), ['1 open sub-issue', 'waits for Rule', 'holds up 1'])
    t.eq('no family, no tags', familyTags(null), [])
  }

  t.section('listIssues and issueFamily on real issue folders')
  {
    const f = await engineFixture({})
    const D = 'devpanel-project'
    const read = (p, i) => f.issues.getIssue(p, i)
    const parent = f.issue
    const child = await f.issues.createIssue(D, { name: 'Child', openedBy: { user: 'engine', from: { project: D, issueId: parent.id, via: 'finding' } } })
    const rule = await f.issues.createIssue(D, { name: 'Rule' })
    await setIssueDependencies(D, child.id, { dependsOn: [rule.id], reason: 'needs the rule' }, { getIssue: read })
    const listed = await f.issues.listIssues(D)
    const at = (id) => listed.find((i) => i.id === id).family
    t.eq('the list carries children', at(parent.id).children, [child.id])
    t.eq('and waits', at(child.id).waitingOn.map((w) => w.id), [rule.id])
    const fam = await f.issues.issueFamily(D, child.id)
    t.eq('the page names the parent with how it came', [fam.parent.id, fam.parent.via], [parent.id, 'finding'])
    t.eq('and the prerequisite with its reason', [fam.dependsOn.map((m) => m.id), fam.dependsOnReason], [[rule.id], 'needs the rule'])
    t.eq('the prerequisite lists what waits for it', (await f.issues.issueFamily(D, rule.id)).blocks.map((m) => m.id), [child.id])
    await f.issues.setIssueArchived(D, parent.id, true)
    const active = await f.issues.listIssues(D)
    t.eq('an archived parent is still named from the active list', active.find((i) => i.id === child.id).family.parent.known, true)
  }
}
